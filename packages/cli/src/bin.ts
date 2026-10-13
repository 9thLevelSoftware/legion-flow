#!/usr/bin/env node
import { CommanderError } from "commander";
import { createCli } from "./cli.js";
import { LEGION_CLI_ONLY_VERBS, LEGION_ASCENDED_ONLY_VERBS } from "./catalog.js";
import { EXIT_CODES, EXIT_UNEXPECTED } from "./runner.js";

const HELP_OR_VERSION = new Set(["--help", "-h", "--version", "-V"]);

async function main(): Promise<void> {
  const verb = process.argv[2];

  // Reciprocal Sibling Refusal (argv[2] inspection)
  if (verb) {
    if ((LEGION_CLI_ONLY_VERBS as readonly string[]).includes(verb)) {
      console.error(
        `legion-flow: '${verb}' belongs to legion-cli. Use 'legion-cli ${verb}' instead.`
      );
      process.exit(EXIT_CODES.refused);
    }

    if ((LEGION_ASCENDED_ONLY_VERBS as readonly string[]).includes(verb)) {
      console.error(
        `legion-flow: '${verb}' belongs to legion-ascended. Use 'legion ${verb}' instead.`
      );
      process.exit(EXIT_CODES.refused);
    }

    // Intercept bare help --all: rewrite the verb and drop the flag, which help-all does not declare.
    if (verb === "help" && process.argv.includes("--all")) {
      process.argv = [
        ...process.argv.slice(0, 2),
        "help-all",
        ...process.argv.slice(3).filter((arg) => arg !== "--all"),
      ];
    }
  }

  // Bare command convention: with no verb, default to status. Flags alone
  // (such as --json) do not count as a verb; --help and --version do not default.
  const args = process.argv.slice(2);
  const hasVerb = args.some((arg) => !arg.startsWith("-"));
  const asksHelpOrVersion = args.some((arg) => HELP_OR_VERSION.has(arg));
  if (!hasVerb && !asksHelpOrVersion) {
    process.argv.splice(2, 0, "status");
  }

  const cli = createCli();
  try {
    await cli.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version arrive here with exitCode 0; everything else is a
      // usage error. Commander has already written its message to stderr. No
      // envelope is emitted: parsing failed before any command existed.
      process.exitCode = err.exitCode === 0 ? 0 : EXIT_CODES.usage_error;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("Fatal error:", (err as Error).message);
  process.exit(EXIT_UNEXPECTED);
});
