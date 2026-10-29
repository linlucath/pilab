import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import type { SubagentToolUiMetadata } from "./tool-ui.ts";

export interface ToolDefinition<TParameters extends TSchema, TContext, TResult> {
  name: string;
  description: string;
  parameters: TParameters;
  ui: SubagentToolUiMetadata;
  defaultActive?: boolean;
  execute(input: Static<TParameters>, context: TContext): Promise<TResult>;
}

export interface RegisteredTool<TContext> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly ui: SubagentToolUiMetadata;
  readonly defaultActive?: boolean;
  readonly execute: (input: unknown, context: TContext) => Promise<unknown>;
}

/**
 * The schema stored here is the sole contract for model declarations, runtime validation,
 * and Static<TSchema> handler inference. The registry erases that generic only after
 * capturing a schema-checked invocation closure.
 */
export class ToolRegistry<TContext> {
  private readonly definitions = new Map<string, RegisteredTool<TContext>>();

  register<TParameters extends TSchema, TResult>(definition: ToolDefinition<TParameters, TContext, TResult>): this {
    if (!definition.name.trim()) throw new Error("Tool names must not be empty.");
    if (this.definitions.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    const registered: RegisteredTool<TContext> = Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      ui: Object.freeze({ ...definition.ui }),
      defaultActive: definition.defaultActive,
      execute: async (input: unknown, context: TContext) => {
        if (!Value.Check(definition.parameters, input)) {
          const issues = [...Value.Errors(definition.parameters, input)]
            .slice(0, 5)
            .map((issue) => `${"path" in issue ? issue.path || "/" : "/"}: ${issue.message}`)
            .join("; ");
          throw new Error(`Invalid arguments for ${definition.name}${issues ? ` (${issues})` : ""}`);
        }
        return definition.execute(input as Static<TParameters>, context);
      },
    });
    this.definitions.set(definition.name, registered);
    return this;
  }

  get(name: string): RegisteredTool<TContext> {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    return definition;
  }

  list(): readonly RegisteredTool<TContext>[] {
    return [...this.definitions.values()];
  }

  execute(name: string, input: unknown, context: TContext): Promise<unknown> {
    return this.get(name).execute(input, context);
  }
}
