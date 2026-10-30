// each `expect-plugin` line must draw a plugin diagnostic; no other line may.
// run by lint/check-fixtures.mjs, excluded from the root lint in biome.json.
import { sql } from "drizzle-orm";
import { z } from "zod";

export const zeroArgs = z.coerce.boolean(); // expect-plugin
export const chained = z.coerce.boolean().default(false); // expect-plugin
export const oneArg = z.coerce.boolean({ error: "x" }); // expect-plugin
export const rawString = sql.raw("x"); // expect-plugin
export const rawTemplate = sql.raw(`x ${zeroArgs}`); // expect-plugin
export const rawNoArgs = sql.raw(); // expect-plugin
export const stage = process.env.NODE_ENV === "production"; // expect-plugin
export const stageFlipped = "test" !== process.env.NODE_ENV; // expect-plugin

export const okBoolean = z.stringbool();
export const okSql = sql`select ${okBoolean}`;
export const okEnv = process.env.NODE_ENV === undefined;
