/**
 * Tool registration for the build engine.
 *
 * The existing `ToolFactory` gates every call on a live Minecraft connection. The build engine has
 * no connection to gate on — it edits an in-memory volume and writes files — so it gets its own
 * thin registrar with the same ergonomics: zod validation, uniform error envelopes, and a place to
 * put the one thing the original could not return, which is images.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError, type ZodRawShape } from "zod";

import { log } from "../logger.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
  [key: string]: unknown;
}

export const text = (value: string): ToolResponse => ({ content: [{ type: "text", text: value }] });

export const lines = (value: readonly string[]): ToolResponse => text(value.join("\n"));

/** A response carrying rendered previews, which is what the agent looks at before committing. */
export const withImages = (
  message: string,
  images: readonly { name: string; png: Buffer }[],
): ToolResponse => ({
  content: [
    { type: "text", text: message },
    ...images.map(
      (image): ToolContent => ({
        type: "image",
        data: image.png.toString("base64"),
        mimeType: "image/png",
      }),
    ),
  ],
});

export const failure = (message: string): ToolResponse => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** JSON that stays readable in a tool response: no giant arrays, no surprises. */
export function json(value: unknown, maxChars = 12_000): ToolResponse {
  const rendered = JSON.stringify(value, null, 2);
  if (rendered.length <= maxChars) return text(rendered);
  return text(
    `${rendered.slice(0, maxChars)}\n... (truncated; ${rendered.length - maxChars} more characters)`,
  );
}

export class BuildToolRegistry {
  private readonly names: string[] = [];

  constructor(private readonly server: McpServer) {}

  register<Shape extends ZodRawShape>(
    name: string,
    description: string,
    schema: Shape,
    handler: (args: Record<string, unknown>) => Promise<ToolResponse> | ToolResponse,
  ): void {
    this.names.push(name);
    // The SDK types its callback against its own content union. Ours is a structural subset of it
    // (text and image), so the cast is a type-level bridge, not a behavioural one.
    const callback = async (args: unknown): Promise<ToolResponse> => {
      try {
        return await handler((args ?? {}) as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ZodError) {
          const detail = error.errors.map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`).join("; ");
          return failure(`${name}: invalid arguments — ${detail}`);
        }
        const message = error instanceof Error ? error.message : String(error);
        log("error", `${name} failed: ${message}`);
        return failure(`${name} failed: ${message}`);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.server.tool(name, description, schema, callback as any);
  }

  registered(): readonly string[] {
    return this.names;
  }
}
