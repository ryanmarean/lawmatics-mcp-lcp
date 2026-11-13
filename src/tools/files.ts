import { readFile, stat } from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LawmaticsApiError, lawmaticsGetAll, lawmaticsPostMultipart } from "../lawmatics-client.js";
import { isHostedMode } from "../session-context.js";
import { registerTool } from "../tool-helpers.js";

/**
 * Lawmatics accepts up to 1 GB per file but recommends staying under 100 MB.
 * Inline base64 travels inside one MCP message (and ~33% larger), so it gets
 * a tighter cap than a file read from disk.
 */
export const MAX_FILE_PATH_BYTES = 100 * 1024 * 1024;
export const MAX_BASE64_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".rtf": "application/rtf",
  ".html": "text/html",
  ".eml": "message/rfc822",
  ".msg": "application/vnd.ms-outlook",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

export function guessMimeType(fileName: string): string {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strict base64 decode — Buffer.from silently skips bad characters, which would upload a corrupt file. */
export function decodeBase64(input: string): Buffer {
  // Accept a data: URL prefix and line-wrapped base64.
  const cleaned = input.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new LawmaticsApiError(422, "content_base64 is not valid base64.");
  }
  return Buffer.from(cleaned, "base64");
}

type UploadArgs = {
  matter_id: string;
  file_path?: string;
  content_base64?: string;
  file_name?: string;
  name?: string;
  folder_id?: string;
  no_folder?: boolean;
  new_folder_path?: string[];
  create_folder?: boolean;
  mime_type?: string;
};

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type MatterFolder = { id: string; name: string; parent_id: string | null; path: string[] };

/**
 * Every folder on a matter, with its full path from the matter's top level.
 * Uses the Folders endpoint's direct `matter_id` param (the only endpoint that
 * filters this way) and `fields=all`, which is what exposes the parent folder_id.
 */
export async function listMatterFolders(matterId: string): Promise<{ folders: MatterFolder[]; complete: boolean }> {
  const result = await lawmaticsGetAll("/folders", { matter_id: matterId, fields: "all" });
  const byId = new Map<string, { name: string; parent_id: string | null }>();
  for (const f of result.items) {
    const parent = f["folder_id"];
    byId.set(f.id, {
      name: String(f["name"] ?? ""),
      parent_id: parent === null || parent === undefined ? null : String(parent),
    });
  }
  const pathOf = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const node: { name: string; parent_id: string | null } = byId.get(cur)!;
      out.unshift(node.name);
      cur = node.parent_id;
    }
    return out;
  };
  const folders = [...byId.entries()]
    .map(([id, f]) => ({ id, name: f.name, parent_id: f.parent_id, path: pathOf(id) }))
    .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")));
  return { folders, complete: result.complete };
}

/** Case-insensitive exact match of a full folder path among existing folders. */
function findByPath(folders: MatterFolder[], wanted: string[]): MatterFolder | undefined {
  const key = wanted.map((s) => s.trim().toLowerCase()).join("\u0000");
  return folders.find((f) => f.path.map((s) => s.toLowerCase()).join("\u0000") === key);
}

type FolderTarget =
  | { kind: "prompt"; reply: Record<string, unknown> }
  | { kind: "root" }
  | { kind: "existing"; folder: MatterFolder }
  | { kind: "create"; path: string[] };

/**
 * Decide where the file goes. The tool never picks a folder on its own and
 * never creates one implicitly: with no choice it returns the matter's folders
 * so the assistant can ask the user, and creating needs create_folder: true.
 */
async function resolveFolder(args: UploadArgs): Promise<FolderTarget> {
  const chosen = [args.folder_id !== undefined, args.no_folder === true, args.new_folder_path !== undefined].filter(
    Boolean
  ).length;
  if (chosen > 1) {
    throw new LawmaticsApiError(422, "Choose only one of folder_id, no_folder, or new_folder_path.");
  }
  if (args.no_folder) return { kind: "root" };

  const { folders, complete } = await listMatterFolders(args.matter_id);
  const listing = folders.map((f) => ({ folder_id: f.id, path: f.path.join(" / ") }));

  if (chosen === 0) {
    return {
      kind: "prompt",
      reply: {
        uploaded: false,
        needs_folder_choice: true,
        matter_id: args.matter_id,
        existing_folders: listing,
        ...(complete ? {} : { folders_list_complete: false }),
        message:
          "Nothing was uploaded. Ask the user which folder this file should go in: one of existing_folders " +
          "(pass its folder_id), no folder (pass no_folder: true), or a new folder (pass new_folder_path with " +
          "create_folder: true — only if the user explicitly asks for a new folder). Then call upload-file again.",
      },
    };
  }

  if (args.folder_id !== undefined) {
    const folder = folders.find((f) => f.id === String(args.folder_id));
    if (!folder) {
      throw new LawmaticsApiError(
        422,
        `Folder ${args.folder_id} is not on matter ${args.matter_id}. Existing folders: ` +
          (listing.length ? listing.map((f) => `${f.folder_id} (${f.path})`).join(", ") : "none") +
          ". Nothing was uploaded."
      );
    }
    return { kind: "existing", folder };
  }

  const wanted = (args.new_folder_path ?? []).map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) throw new LawmaticsApiError(422, "new_folder_path must name at least one folder.");
  const existing = findByPath(folders, wanted);
  if (existing) {
    throw new LawmaticsApiError(
      422,
      `A folder "${existing.path.join(" / ")}" already exists on this matter (folder_id ${existing.id}). ` +
        "Use folder_id to upload into it. Nothing was uploaded."
    );
  }
  if (args.create_folder !== true) {
    throw new LawmaticsApiError(
      422,
      `Folder "${wanted.join(" / ")}" does not exist on this matter, and folders are only created when the user ` +
        "explicitly asks. Confirm with the user, then retry with create_folder: true — or pick an existing folder: " +
        (listing.length ? listing.map((f) => `${f.folder_id} (${f.path})`).join(", ") : "none") +
        ". Nothing was uploaded."
    );
  }
  return { kind: "create", path: wanted };
}

async function loadFile(args: UploadArgs): Promise<{ bytes: Buffer; fileName: string }> {
  const hasPath = Boolean(args.file_path);
  const hasContent = Boolean(args.content_base64);
  if (hasPath === hasContent) {
    throw new LawmaticsApiError(422, "Provide exactly one of file_path or content_base64.");
  }

  if (args.file_path) {
    // In hosted mode file_path would read the SERVER's disk, not the user's —
    // and could be used to push server files (token store, config) into Lawmatics.
    if (isHostedMode()) {
      throw new LawmaticsApiError(
        422,
        "file_path is not available on the hosted server (it cannot see files on your computer). " +
          "Send the file as content_base64 with file_name instead."
      );
    }
    const resolved = path.resolve(args.file_path);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new LawmaticsApiError(422, `File not found or not readable: ${resolved}`);
    }
    if (!info.isFile()) throw new LawmaticsApiError(422, `Not a file: ${resolved}`);
    if (info.size === 0) throw new LawmaticsApiError(422, `File is empty: ${resolved}`);
    if (info.size > MAX_FILE_PATH_BYTES) {
      throw new LawmaticsApiError(
        422,
        `File is ${mb(info.size)}; this tool uploads files up to ${mb(MAX_FILE_PATH_BYTES)} ` +
          "(Lawmatics recommends staying under 100 MB). Upload it in the Lawmatics web app instead."
      );
    }
    return { bytes: await readFile(resolved), fileName: args.file_name || path.basename(resolved) };
  }

  if (!args.file_name) {
    throw new LawmaticsApiError(422, "file_name (with extension, e.g. 'engagement-letter.pdf') is required with content_base64.");
  }
  const bytes = decodeBase64(args.content_base64!);
  if (bytes.length === 0) throw new LawmaticsApiError(422, "content_base64 decodes to an empty file.");
  if (bytes.length > MAX_BASE64_BYTES) {
    throw new LawmaticsApiError(
      422,
      `Decoded file is ${mb(bytes.length)}; inline uploads are capped at ${mb(MAX_BASE64_BYTES)}. ` +
        "Use file_path (local server only) or upload it in the Lawmatics web app."
    );
  }
  return { bytes, fileName: args.file_name };
}

export function registerFileTools(server: McpServer): void {
  registerTool(server, {
    name: "list-matter-folders",
    description:
      "List the document folders on a matter, each with its folder_id and full path (e.g. 'Pleadings / Drafts'). " +
      "Use before upload-file so you can ask the user which folder a file belongs in.",
    schema: {
      matter_id: z.coerce.string().describe("The Lawmatics matter (prospect) ID."),
    },
    handler: async (args: { matter_id: string }) => {
      const { folders, complete } = await listMatterFolders(args.matter_id);
      return {
        matter_id: args.matter_id,
        items: folders.map((f) => ({ folder_id: f.id, name: f.name, path: f.path.join(" / "), parent_id: f.parent_id })),
        ...(complete ? {} : { complete: false }),
      };
    },
  });

  registerTool(server, {
    name: "upload-file",
    write: true,
    description:
      "Upload a file (PDF, Word document, image, etc.) to a matter's Documents in Lawmatics. " +
      "Provide the file EITHER as file_path (a path on the machine running this server; local installs only) " +
      "OR as content_base64 plus file_name. " +
      "FOLDER: never choose a folder yourself. Before uploading, call list-matter-folders and ASK THE USER which " +
      "folder to use (or none). Then pass exactly one of: folder_id (an existing folder), no_folder: true (top " +
      "level), or new_folder_path with create_folder: true — only when the user explicitly asked for a new folder. " +
      "If no folder choice is passed, nothing is uploaded and the matter's folders are returned so you can ask.",
    schema: {
      matter_id: z.coerce.string().describe("The Lawmatics matter (prospect) ID to attach the file to."),
      file_path: z
        .string()
        .optional()
        .describe(`Absolute path to a local file (max ${mb(MAX_FILE_PATH_BYTES)}). Not available on the hosted server.`),
      content_base64: z
        .string()
        .optional()
        .describe(`The file's bytes, base64-encoded (max ${mb(MAX_BASE64_BYTES)} decoded). Requires file_name.`),
      file_name: z
        .string()
        .optional()
        .describe("File name with extension, e.g. 'retainer.pdf'. Required with content_base64; defaults to the file_path name."),
      name: z.string().optional().describe("Display name in Lawmatics. Defaults to the file name."),
      folder_id: z.coerce
        .string()
        .optional()
        .describe("ID of an existing folder on this matter (from list-matter-folders), as chosen by the user."),
      no_folder: z.boolean().optional().describe("true = upload to the matter's top level, when the user wants no folder."),
      new_folder_path: z
        .array(z.string().min(1))
        .optional()
        .describe("Path of a NEW folder to create, e.g. ['Pleadings', 'Drafts']. Requires create_folder: true."),
      create_folder: z
        .boolean()
        .optional()
        .describe("Set true ONLY when the user explicitly asked to create the folder in new_folder_path."),
      mime_type: z.string().optional().describe("Override the MIME type (otherwise guessed from the extension)."),
    },
    // Never write file contents into the audit log — record size instead.
    auditArgs: (args) => {
      const { content_base64, ...rest } = args;
      return typeof content_base64 === "string"
        ? { ...rest, content_base64: `<omitted: ${content_base64.length} base64 chars>` }
        : rest;
    },
    handler: async (args: UploadArgs) => {
      // Validate the file first so a bad path/encoding surfaces before the folder question.
      const { bytes, fileName } = await loadFile(args);
      const target = await resolveFolder(args);
      if (target.kind === "prompt") return target.reply;

      const form = new FormData();
      form.append("documentable_type", "matter");
      form.append("documentable_id", args.matter_id);
      if (args.name) form.append("name", args.name);
      if (target.kind === "existing") form.append("folder_id", target.folder.id);
      if (target.kind === "create") for (const folder of target.path) form.append("path[]", folder);
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: args.mime_type || guessMimeType(fileName) }),
        fileName
      );
      const uploaded = await lawmaticsPostMultipart("/files", form);
      return {
        uploaded: true,
        folder:
          target.kind === "root"
            ? "(none — top level)"
            : target.kind === "existing"
              ? target.folder.path.join(" / ")
              : `${target.path.join(" / ")} (created if it did not exist)`,
        file: uploaded,
      };
    },
  });
}
