import { request } from "node:http";

/** The sprite's management socket; the Tasks API answers on it under virtual host `sprite`. */
const SPRITE_API_SOCKET = "/.sprite/api.sock";
// a missed refresh or a runner killed outright leaves the task to lapse on its own
const EXPIRE = "5m";
const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export type SpriteHold = { release: () => Promise<void> };

/**
 * Keeps the sprite from pausing while the runner lives: a sprite pauses once idle and drops
 * open connections even on a warm pause, so the runner holds a Tasks API task, refreshed on an
 * interval (a task lives an hour at most), and deletes it on `release`. Never throws: with no
 * socket (tests, local runs) it says so once on `warn`; a failed call is one line on `warn`.
 */
export function holdSprite(options: {
  name: string;
  warn: (message: string) => void;
  socketPath?: string;
  refreshMs?: number;
}): SpriteHold {
  const socketPath = options.socketPath ?? SPRITE_API_SOCKET;
  const path = `/v1/tasks/${encodeURIComponent(options.name)}`;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  let socketFound: boolean | undefined;
  const call = async (method: "PUT" | "DELETE", body?: string) => {
    try {
      await send(socketPath, method, path, body);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        socketFound === undefined &&
        (code === "ENOENT" || code === "ECONNREFUSED")
      ) {
        options.warn(
          `runner: no sprite API at ${socketPath}; the sprite may pause while the run is idle`,
        );
        return false;
      }
      options.warn(
        `runner: sprite task ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  };

  const refresh = async () => {
    socketFound = await call("PUT", JSON.stringify({ expire: EXPIRE }));
    if (socketFound && !stopped)
      // unref: the hold never keeps a finished runner alive
      timer = setTimeout(() => {
        inFlight = refresh();
      }, options.refreshMs ?? REFRESH_MS).unref();
  };
  let inFlight = refresh();

  return {
    release: async () => {
      stopped = true;
      clearTimeout(timer);
      // a PUT landing after the DELETE would bring the task back
      await inFlight;
      if (socketFound) await call("DELETE");
    },
  };
}

function send(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        host: "sprite",
        path,
        method,
        headers: body ? { "content-type": "application/json" } : {},
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode && res.statusCode < 300
            ? resolve()
            : reject(new Error(`HTTP ${res.statusCode}`)),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
