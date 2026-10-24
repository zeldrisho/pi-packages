/** A simple command whose words contain no shell expansion or evaluation syntax. */
export interface LiteralCommand {
  text: string;
  literalOutput: boolean;
}

const MAX_LITERAL_COMMAND_CHARACTERS = 65_536;

/**
 * Recognizes only literal words, quotes, comments, and command separators.
 * Unsupported syntax returns undefined for the entire input: callers must use
 * conservative text matching, not treat an unrecognized command as safe.
 * This does not expand variables, execute commands, or attempt full Bash parsing.
 */
export function literalCommands(command: string): LiteralCommand[] | undefined {
  if (command.length > MAX_LITERAL_COMMAND_CHARACTERS) return undefined;

  const commands: LiteralCommand[] = [];
  let words: string[] = [];
  let word = "";
  let active = false;
  let quote: "'" | '"' | undefined;
  let opaque = false;

  const finishWord = () => {
    if (!active) return;
    words.push(word);
    word = "";
    active = false;
  };

  const finishCommand = () => {
    finishWord();

    if (words.length === 0) return;
    const literalOutput = words[0] === "echo" || words[0] === "printf";

    // Other programs may interpret quoted arguments as scripts. Do not discard
    // shell-looking text passed to bash -c, eval, Python, or other interpreters.
    if (!literalOutput && words.some((value) => /[\s$`(){}<>;&|*?[\]~!]/u.test(value))) {
      opaque = true;
    }

    commands.push({ text: words.join(" "), literalOutput });
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }

    if (char === "\\") {
      const next = command[index + 1];

      // Continued lines and trailing escapes need the conservative matcher.
      if (next === undefined || next === "\n" || next === "\r") return undefined;

      // Inside double quotes, only these characters lose their backslash.
      if (quote === '"' && !'"\\$`'.includes(next)) word += "\\";
      word += next;
      active = true;
      index += 1;
      continue;
    }

    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "$" || char === "`") return undefined;
      else word += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (char === "#" && !active) {
      while (index < command.length && command[index] !== "\n") index += 1;
      finishCommand();
    } else if (char === "\n" || char === ";" || char === "&" || char === "|") {
      // Printed text can become executable input down a pipeline.
      if (char === "|" && command[index + 1] !== "|") return undefined;
      finishCommand();

      if ((char === "&" || char === "|") && command[index + 1] === char) index += 1;
    } else if (/\s/u.test(char ?? "")) {
      finishWord();
    } else if ("$`(){}<>*?[]~!".includes(char ?? "")) {
      // Expansions, grouping, redirects, and globs are not parsed.
      return undefined;
    } else {
      word += char;
      active = true;
    }
  }

  if (quote !== undefined) return undefined;
  finishCommand();

  return opaque ? undefined : commands;
}
