import { Command } from "commander";
import { Workspace } from "@9thlevelsoftware/legion-flow-persist";
import { COMMAND_CATALOG, type CommandEntry } from "./catalog.js";
import { plannedVerbCommand, CLI_VERSION } from "./commands.js";
import { runCommand, processIo, type CommandContext, type RunnerIo } from "./runner.js";

export interface CreateCliOptions {
  /** Output sink; defaults to the real process. Tests pass a capturing one. */
  io?: RunnerIo;
  /** Context factory; defaults to process.cwd() and stdin.isTTY. */
  context?: () => CommandContext;
  /** The verbs to register; defaults to the command catalog. Tests pass a synthetic one. */
  catalog?: readonly CommandEntry[];
}

/** The marker help-all prints beside a verb that registers but is not built yet. */
export function plannedMarker(milestone: string): string {
  return `[PLANNED ${milestone}]`;
}

export function createCli(options: CreateCliOptions = {}): Command {
  const io = options.io ?? processIo;
  const catalog = options.catalog ?? COMMAND_CATALOG;
  const context =
    options.context ??
    (() => {
      const cwd = process.cwd();
      return { cwd, isTTY: Boolean(process.stdin.isTTY), workspace: Workspace.at(cwd) };
    });

  const program = new Command("legion-flow");

  program
    .version(CLI_VERSION)
    .description("Legion Flow — Modern Autonomous Workflow Engine (2027 Paradigm)")
    .option("--json", "Output results formatted as a single JSON envelope to stdout")
    // Usage errors throw CommanderError instead of exiting; bin.ts maps them to exit 2.
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout(str),
      writeErr: (str) => io.stderr(str),
    });

  const json = () => Boolean(program.opts().json);

  // Every verb comes from the catalog. Implemented entries run their handler;
  // planned entries accept any argv shape and answer a typed refusal.
  for (const entry of catalog) {
    const handler = entry.handler;
    const command = program
      .command(entry.name)
      .description(handler || entry.server ? entry.summary : `${entry.summary} ${plannedMarker(entry.milestone)}`);

    for (const opt of entry.options) {
      if (opt.repeatable) {
        command.option(opt.flags, opt.description, (value: string, previous: string[]) => [...previous, value], []);
      } else if (opt.required) {
        command.requiredOption(opt.flags, opt.description);
      } else {
        command.option(opt.flags, opt.description, opt.defaultValue);
      }
    }

    // Positionals are declared in the catalog and folded into the options object by name,
    // so handlers keep one shape: (context, options).
    const argNames = (entry.args ?? "").match(/[<[]([^>\]]+)[>\]]/g)?.map((s) => s.slice(1, -1).replace(/\.\.\.$/, "")) ?? [];
    if (entry.args) {
      command.argument(entry.args);
    }

    if (entry.server) {
      const server = entry.server;
      // The second exemption from the envelope, after help-all: a server owns stdout for the protocol.
      command.action(async (...actionArgs: unknown[]) => {
        const opts = { ...(actionArgs[actionArgs.length - 2] as Record<string, unknown>) };
        await server(context(), opts);
      });
    } else if (handler) {
      command.action(async (...actionArgs: unknown[]) => {
        // Commander passes (...positionals, options, command).
        const opts = { ...(actionArgs[actionArgs.length - 2] as Record<string, unknown>) };
        argNames.forEach((name, i) => {
          opts[name] = actionArgs[i];
        });
        // After every command, enabled Optional CALL hooks get their pending events (M4 slice l); with none enabled this does nothing.
        await runCommand(handler, context(), opts, { json: json(), io, renderText: entry.renderText, afterCommand: async (c) => (await import("./hooks.js")).flushHooks(c.workspace) });
      });
    } else {
      const planned = plannedVerbCommand(entry.name, entry.milestone);
      command
        .allowUnknownOption()
        .allowExcessArguments()
        .action(async () => {
          await runCommand(planned, context(), {}, { json: json(), io });
        });
    }
  }

  // help-all is the one documentation verb exempt from the envelope: it has no
  // phase and no next action, and the strict envelope has no slot for a catalog.
  program
    .command("help-all")
    .description("Display the complete Legion Flow command catalog")
    .action(() => {
      const lines = ["Legion Flow — Full Command Catalog", "=".repeat(60)];
      for (const entry of catalog) {
        const tags = [
          entry.humanOnly ? " [HUMAN-ONLY]" : "",
          entry.handler || entry.server ? "" : ` ${plannedMarker(entry.milestone)}`,
        ].join("");
        lines.push(`${entry.name.padEnd(12)} - ${entry.summary}${tags}`);
        lines.push(`  Usage: ${entry.usage}`, "");
      }
      io.stdout(lines.join("\n") + "\n");
    });

  return program;
}
