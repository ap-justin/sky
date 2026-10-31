import { z } from "zod";

/** What names a base profile; also what an environment's `base` may hold. */
export const BaseProfileName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "expected letters, digits, . _ - (at most 64, starting with a letter or digit)",
  );

const secretName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an env secret's name");

// resolved against $HOME in the sprite, so it can't be absolute or leave it
const homeRelativePath = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0\s]+$/,
    "expected a path under $HOME",
  );

const McpEnv = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  secretName,
);

/**
 * A user-scope MCP server. Credentials are never inline: `env` (stdio) and `headers` (http) map a
 * variable or header name to the NAME of an env secret, which the session expands at run time.
 */
export const BaseProfileMcpServer = z.union([
  z.strictObject({
    command: z.string().min(1).max(500),
    args: z
      .array(z.string().max(500))
      .max(64)
      .default(() => []),
    env: McpEnv.default(() => ({})),
  }),
  z.strictObject({
    url: z.url({ protocol: /^https?$/ }),
    headers: z
      .record(z.string().regex(/^[A-Za-z0-9-]+$/), secretName)
      .default(() => ({})),
  }),
]);
export type BaseProfileMcpServer = z.infer<typeof BaseProfileMcpServer>;

/**
 * Where an optional store lives in the sprite and how its files merge; every field is the
 * profile's, so the runner knows no client's layout.
 */
export const BaseProfileStoreLayout = z.strictObject({
  /** The checkout's directory, under `$HOME`. */
  home: homeRelativePath.default(".sky-store"),
  /** Git exclude patterns for files that stay local to the sprite. */
  exclude: z
    .array(z.string().min(1).max(200))
    .max(64)
    .default(() => []),
  /** Git attribute patterns of append-only line files, merged so concurrent appends both land. */
  lineFiles: z
    .array(z.string().min(1).max(200))
    .max(64)
    .default(() => []),
  /** A merge script under `$HOME`, called as `bash script %O %A %B` when present; `git merge-file --union` otherwise. */
  mergeScript: homeRelativePath.optional(),
});
export type BaseProfileStoreLayout = z.infer<typeof BaseProfileStoreLayout>;

/**
 * Server-side configuration an environment's `base` names: what a sprite gets before the env's own
 * setup, and what the runner tells an agent to do before finishing. Holds no secret values.
 */
export const BaseProfile = z.strictObject({
  /** Sources for `claude plugin marketplace add`. */
  marketplaces: z
    .array(
      z
        .string()
        .regex(/^[^\s-][^\s]*$/)
        .max(300),
    )
    .max(32)
    .default(() => []),
  /** `name@marketplace`, installed at user scope. */
  plugins: z
    .array(
      z
        .string()
        .regex(/^[^@\s]+@[^@\s]+$/)
        .max(200),
    )
    .max(64)
    .default(() => []),
  /** User-scope MCP servers by name. */
  mcpServers: z
    .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), BaseProfileMcpServer)
    .default(() => ({})),
  /** GitHub `owner/name` synced through the env's `GITHUB_CONNECTOR`; unset, nothing syncs. */
  storeRepo: z
    .string()
    .regex(
      /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/,
      "expected a GitHub repo as owner/name",
    )
    .optional(),
  storeLayout: BaseProfileStoreLayout.optional(),
  /** Non-secret variables set in every session, e.g. a plugin's own switch; never put a secret here. */
  sessionEnv: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(500))
    .default(() => ({})),
  /** Lines the runner tells the agent to follow before it finishes: instructions or commands to run. */
  checks: z
    .array(z.string().min(1).max(1000))
    .max(32)
    .default(() => []),
});
export type BaseProfile = z.infer<typeof BaseProfile>;

/** Profiles by name: what `SKY_BASE_PROFILES` holds. */
export const BaseProfiles = z.record(BaseProfileName, BaseProfile);
export type BaseProfiles = z.infer<typeof BaseProfiles>;
