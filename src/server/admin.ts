/**
 * Admin commands for hosted mode, run on the server host:
 *
 *   lawmatics-mcp users list
 *   lawmatics-mcp users remove <lawmatics-user-id>
 *
 * Run them with the server STOPPED (or restart it afterwards): the running
 * server keeps the store in memory and would overwrite the change on its next
 * write.
 */
import { loadHostedConfig } from "./config.js";
import { Store } from "./store.js";

export async function runUsersCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [sub, userId] = args;
  const config = loadHostedConfig(env);
  const store = await Store.open(config.dataDir, config.encryptionKey);

  if (sub === "list") {
    const users = store.listUsers();
    if (!users.length) {
      console.log("No users are connected.");
      return;
    }
    console.table(
      users.map((u) => ({
        id: u.userId,
        name: u.name ?? "",
        email: u.email ?? "",
        connected: u.connectedAt,
        last_seen: u.lastSeenAt ?? "",
      }))
    );
    return;
  }

  if (sub === "remove" && userId) {
    const removed = await store.removeUser(userId);
    await store.flush();
    if (!removed) {
      console.log(`No connected user with id ${userId}.`);
      return;
    }
    console.log(
      `Removed user ${userId}: their stored Lawmatics token and every session token issued to them are deleted.\n` +
        "Lawmatics tokens never expire and Lawmatics has no revocation API. To kill the token at Lawmatics,\n" +
        "email support@lawmatics.com and ask them to revoke this user's tokens for your developer app."
    );
    return;
  }

  throw new Error("Usage: lawmatics-mcp users list | lawmatics-mcp users remove <lawmatics-user-id>");
}
