import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFileTools, decodeBase64, guessMimeType } from "../../src/tools/files.js";
import { __resetRateLimiter } from "../../src/lawmatics-client.js";
import { createMockServer, jsonResponse, listEnvelope, mockFetch, mockFetchWith, parseResult } from "../helpers.js";

// Shape taken from the official "Upload File" example response.
const UPLOAD_RESPONSE = {
  data: {
    id: "48",
    type: "file",
    attributes: {
      name: "retainer.pdf",
      file_size: 11,
      file_name: "retainer.pdf",
      file_type: "application/pdf",
      created_at: "2026-11-12T14:55:13.759-08:00",
    },
    relationships: { documentable: { data: { id: "25", type: "prospect" } } },
  },
};

// Shape observed live from GET /v1/folders?matter_id=…&fields=all.
function folder(id: string, name: string, parent: number | null) {
  return {
    id,
    type: "folder",
    attributes: { name, folder_id: parent },
    relationships: { documentable: { data: { id: "25", type: "prospect" } }, parent_folder: { data: null } },
  };
}
const FOLDERS = listEnvelope([
  folder("10", "Pleadings", null),
  folder("11", "Drafts", 10),
  folder("12", "Correspondence", null),
]);

/** Router: folders list for GETs, upload response for POST /files. */
function lawmatics() {
  return mockFetchWith((url, init) => {
    if (url.includes("/v1/folders")) return jsonResponse(FOLDERS);
    if (url.endsWith("/v1/files") && init?.method === "POST") return jsonResponse(UPLOAD_RESPONSE, { status: 201 });
    return jsonResponse({ errors: [{ title: "unexpected " + url }] }, { status: 500 });
  });
}
const uploads = (fetchMock: ReturnType<typeof lawmatics>) =>
  fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith("/v1/files") && i?.method === "POST");

let tmp: string;
const b64 = (s: string) => Buffer.from(s).toString("base64");

beforeEach(async () => {
  __resetRateLimiter();
  process.env.LAWMATICS_ACCESS_TOKEN = "test-token";
  delete process.env.LAWMATICS_READ_ONLY;
  tmp = await mkdtemp(path.join(tmpdir(), "lm-upload-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.LAWMATICS_READ_ONLY;
  await rm(tmp, { recursive: true, force: true });
});

function setup() {
  const mock = createMockServer();
  registerFileTools(mock.server);
  return mock;
}

describe("list-matter-folders", () => {
  it("queries the matter's folders and builds full paths", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const result = parseResult(await mock.call("list-matter-folders", { matter_id: "25" }));
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/folders");
    expect(url.searchParams.get("matter_id")).toBe("25");
    expect(url.searchParams.get("fields")).toBe("all");
    expect(result.items.map((f: { path: string }) => f.path)).toEqual([
      "Correspondence",
      "Pleadings",
      "Pleadings / Drafts",
    ]);
    expect(result.items.find((f: { folder_id: string }) => f.folder_id === "11").parent_id).toBe("10");
  });
});

describe("upload-file folder choice", () => {
  it("uploads nothing and returns existing folders when no folder choice is given", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const result = parseResult(
      await mock.call("upload-file", { matter_id: "25", content_base64: b64("x"), file_name: "a.pdf" })
    );
    expect(result.uploaded).toBe(false);
    expect(result.needs_folder_choice).toBe(true);
    expect(result.existing_folders).toContainEqual({ folder_id: "11", path: "Pleadings / Drafts" });
    expect(result.message).toMatch(/Ask the user/);
    expect(uploads(fetchMock)).toHaveLength(0);
  });

  it("uploads into an existing folder by folder_id (no path[] sent)", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const result = parseResult(
      await mock.call("upload-file", { matter_id: "25", content_base64: b64("x"), file_name: "a.pdf", folder_id: "11" })
    );
    expect(result).toMatchObject({ uploaded: true, folder: "Pleadings / Drafts" });
    expect(result.file.id).toBe("48");
    const form = uploads(fetchMock)[0][1].body as FormData;
    expect(form.get("folder_id")).toBe("11");
    expect(form.getAll("path[]")).toEqual([]);
  });

  it("rejects a folder_id that is not on the matter", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const res = await mock.call("upload-file", {
      matter_id: "25",
      content_base64: b64("x"),
      file_name: "a.pdf",
      folder_id: "999",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not on matter 25/);
    expect(uploads(fetchMock)).toHaveLength(0);
  });

  it("uploads to the top level with no_folder and skips the folder lookup", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const result = parseResult(
      await mock.call("upload-file", { matter_id: "25", content_base64: b64("x"), file_name: "a.pdf", no_folder: true })
    );
    expect(result.uploaded).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/folders"))).toBe(false);
    const form = uploads(fetchMock)[0][1].body as FormData;
    expect(form.get("folder_id")).toBeNull();
    expect(form.getAll("path[]")).toEqual([]);
  });

  it("refuses to create a new folder without create_folder: true", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const res = await mock.call("upload-file", {
      matter_id: "25",
      content_base64: b64("x"),
      file_name: "a.pdf",
      new_folder_path: ["Corespondence"],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/explicitly asks/);
    expect(res.content[0].text).toMatch(/12 \(Correspondence\)/);
    expect(uploads(fetchMock)).toHaveLength(0);
  });

  it("creates a new folder via path[] when create_folder is true", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const result = parseResult(
      await mock.call("upload-file", {
        matter_id: "25",
        content_base64: b64("x"),
        file_name: "a.pdf",
        new_folder_path: ["Pleadings", "Final"],
        create_folder: true,
      })
    );
    expect(result.uploaded).toBe(true);
    const form = uploads(fetchMock)[0][1].body as FormData;
    expect(form.getAll("path[]")).toEqual(["Pleadings", "Final"]);
  });

  it("redirects new_folder_path to folder_id when that folder already exists", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    const res = await mock.call("upload-file", {
      matter_id: "25",
      content_base64: b64("x"),
      file_name: "a.pdf",
      new_folder_path: ["pleadings", "drafts"],
      create_folder: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/already exists.*folder_id 11/);
    expect(uploads(fetchMock)).toHaveLength(0);
  });

  it("rejects more than one folder choice", async () => {
    const mock = setup();
    lawmatics();
    const res = await mock.call("upload-file", {
      matter_id: "25",
      content_base64: b64("x"),
      file_name: "a.pdf",
      folder_id: "11",
      no_folder: true,
    });
    expect(res.content[0].text).toMatch(/only one of/);
  });
});

describe("upload-file file handling", () => {
  it("uploads a local file as multipart to /files on the matter", async () => {
    const file = path.join(tmp, "retainer.pdf");
    await writeFile(file, "hello world");
    const mock = setup();
    const fetchMock = lawmatics();

    const result = parseResult(await mock.call("upload-file", { matter_id: "25", file_path: file, no_folder: true }));
    expect(result.file).toMatchObject({ id: "48", file_name: "retainer.pdf" });
    expect(result.file.related.documentable).toEqual({ id: "25", type: "prospect" });

    const [url, init] = uploads(fetchMock)[0];
    expect(url).toBe("https://api.lawmatics.com/v1/files");
    // fetch must set the multipart boundary itself.
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const form = init!.body as FormData;
    expect(form.get("documentable_type")).toBe("matter");
    expect(form.get("documentable_id")).toBe("25");
    const blob = form.get("file") as File;
    expect(blob.name).toBe("retainer.pdf");
    expect(blob.type).toBe("application/pdf");
    expect(await blob.text()).toBe("hello world");
  });

  it("uploads base64 content with file_name and display name", async () => {
    const mock = setup();
    const fetchMock = lawmatics();
    await mock.call("upload-file", {
      matter_id: 25,
      content_base64: b64("memo text"),
      file_name: "memo.docx",
      name: "Intake memo",
      no_folder: true,
    });
    const form = uploads(fetchMock)[0][1]!.body as FormData;
    expect(form.get("name")).toBe("Intake memo");
    const blob = form.get("file") as File;
    expect(blob.name).toBe("memo.docx");
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await blob.text()).toBe("memo text");
  });

  it("requires exactly one file source", async () => {
    const mock = setup();
    const fetchMock = mockFetch();
    const none = await mock.call("upload-file", { matter_id: "25", no_folder: true });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/exactly one/);
    const both = await mock.call("upload-file", {
      matter_id: "25",
      file_path: "/x.pdf",
      content_base64: "aGk=",
      file_name: "x.pdf",
      no_folder: true,
    });
    expect(both.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires file_name with content_base64 and rejects invalid base64", async () => {
    const mock = setup();
    mockFetch();
    const noName = await mock.call("upload-file", { matter_id: "25", content_base64: "aGk=", no_folder: true });
    expect(noName.content[0].text).toMatch(/file_name/);
    const bad = await mock.call("upload-file", {
      matter_id: "25",
      content_base64: "not base64!!",
      file_name: "a.pdf",
      no_folder: true,
    });
    expect(bad.content[0].text).toMatch(/not valid base64/);
  });

  it("reports a missing local file without calling Lawmatics", async () => {
    const mock = setup();
    const fetchMock = mockFetch();
    const res = await mock.call("upload-file", { matter_id: "25", file_path: path.join(tmp, "nope.pdf") });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses file_path in hosted mode (would read the server's disk)", async () => {
    const file = path.join(tmp, "secret.txt");
    await writeFile(file, "server secret");
    vi.stubEnv("TRANSPORT", "http");
    const mock = setup();
    const fetchMock = mockFetch();
    const res = await mock.call("upload-file", { matter_id: "25", file_path: file, no_folder: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not available on the hosted server/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not registered in read-only mode, but list-matter-folders is", () => {
    process.env.LAWMATICS_READ_ONLY = "1";
    const mock = setup();
    expect(mock.has("upload-file")).toBe(false);
    expect(mock.has("list-matter-folders")).toBe(true);
  });

  it("returns not_found when the matter does not exist", async () => {
    const mock = setup();
    mockFetch(jsonResponse({ errors: [{ status: 404, title: "Not Found" }] }, { status: 404 }));
    const res = parseResult(
      await mock.call("upload-file", { matter_id: "999", content_base64: "aGk=", file_name: "a.txt", no_folder: true })
    );
    expect(res.not_found).toBe(true);
  });
});

describe("helpers", () => {
  it("decodeBase64 accepts data: URLs and wrapped lines", () => {
    expect(decodeBase64("data:application/pdf;base64,aGVs\nbG8=").toString()).toBe("hello");
  });

  it("guessMimeType falls back to octet-stream", () => {
    expect(guessMimeType("scan.PDF")).toBe("application/pdf");
    expect(guessMimeType("archive.xyz")).toBe("application/octet-stream");
  });
});
