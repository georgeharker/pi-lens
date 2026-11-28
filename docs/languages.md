# Per-language settings (`languages`)

pi-lens picks a language server, linters, a formatter, and the tools that
fix lint findings (autofix) for each file on its own. The `languages`
setting lets you make those choices yourself, one language at a time.

It is opt-in, and it is experimental. A language you do not list keeps the
automatic choice exactly as it is today. So does any setting you leave out
of a language you do list. For example, an entry with only `format` leaves
that language's server and linters alone.

## Quick start

Put a `languages` section in `~/.pi-lens/config.json` (for every project) or
in a project's `.pi-lens.json` (for that project only).

**Use shuck for every zsh file, including your dotfiles:**

```jsonc
{
  "languages": {
    "zsh": {
      "files": [".zshrc", ".zshenv", ".zprofile", "functions/*"],
      "lsp": { "server": "shuck" },
      "format": { "formatter": "shfmt" }
    }
  }
}
```

This covers `.zsh` files, `.sh` files whose first line is `#!/bin/zsh`,
extensionless scripts such as `bin/deploy` with that first line, and the
dotfiles listed under `files`.

**Make your own language server the primary one for shell scripts:**

```jsonc
{
  "lsp": {
    "servers": {
      "my-shell-lsp": { "extensions": [".sh"], "command": "my-shell-lsp" }
    }
  },
  "languages": { "shell": { "lsp": { "server": "my-shell-lsp" } } }
}
```

Without `languages`, a server you add under `lsp.servers` never outranks a
built-in server for the same extension.

**Run both ESLint and oxlint on TypeScript, and format it with Prettier:**

```jsonc
{
  "languages": {
    "typescript": {
      "lint": { "tools": ["eslint", "oxlint"], "mode": "all" },
      "format": { "formatter": "prettier" }
    }
  }
}
```

Without `languages`, pi-lens runs the first of ESLint, oxlint, and Biome that
the project's config files point to.

**Use Ruff when pi-lens can find it, and mypy otherwise:**

```jsonc
{
  "languages": {
    "python": { "lint": { "tools": ["ruff-lint", "mypy"], "mode": "fallback" } }
  }
}
```

**Lint with oxlint, and let only oxlint fix files:**

```jsonc
{
  "languages": {
    "typescript": { "lint": { "tools": ["oxlint"], "mode": "all" } }
  }
}
```

When you set `lint` and leave out `autofix`, autofix uses the same tools. So
`eslint --fix` does not rewrite the file when you chose oxlint.

**Turn off the language server, linters, formatting, and autofix for Python:**

```jsonc
{
  "languages": {
    "python": {
      "lsp": { "enabled": false },
      "lint": { "enabled": false },
      "format": { "enabled": false },
      "autofix": { "enabled": false }
    }
  }
}
```

## Language names

Each key under `languages` names a language. Use these names:

| Name | Files |
| --- | --- |
| `typescript`, `typescriptreact` | `.ts`, `.mts`, `.cts`; `.tsx` |
| `javascript`, `javascriptreact` | `.js`, `.mjs`, `.cjs`; `.jsx` |
| `python` | `.py`, `.pyi` |
| `c`, `cpp` | `.c`, `.h`; `.cpp`, `.cc`, `.hpp`, and others |
| `go`, `rust`, `ruby`, `java`, `lua`, `php`, … | The usual extensions for that language. |
| `shell` | Every shell file: `.sh`, `.bash`, `.zsh`, `Makefile`. |
| `zsh`, `bash`, `sh`, `dash`, `ksh`, `mksh`, `ash`, `busybox` | Shell files of that dialect only. |

The full list of names is the language registry in
`clients/language-registry.ts`. pi-lens ignores a name it does not know, and
shows a warning.

`typescript` and `typescriptreact` are separate languages, so a setting for
`typescript` does not apply to `.tsx` files. Write both entries to cover both.

## How pi-lens finds the entry for a file

pi-lens takes these steps for every file, and the first match wins:

1. If an entry's `files` list has a pattern that matches the file, that entry
   applies.
2. Otherwise, pi-lens decides the file's language from its file name or its
   extension. `deploy.py` is `python`, and `Dockerfile` is `dockerfile`.
3. If the file has no extension and pi-lens does not know its name, the first
   line decides. `bin/tool` starting with `#!/usr/bin/env python3` is
   `python`. A file with an extension never uses its first line for this.
4. For a shell file, pi-lens also decides the dialect. It uses the dialect
   entry first (`zsh`), then the `shell` entry.
5. If no entry matches, the file keeps the automatic choice.

### How the shell dialect is decided

pi-lens reads the start of the file and checks these in order:

1. A `# shellcheck shell=<dialect>` comment near the top.
2. The first line, such as `#!/usr/bin/env zsh`.
3. The extension: `.zsh` is zsh, `.bash` is bash.
4. Otherwise, the file is bash.

A shell file that states none of these, such as a `Makefile`, uses only the
`shell` entry, never `bash`.

### First lines that set a language

These programs on the first line of an extensionless file set its language.
pi-lens ignores a version number after the name, so `python3.12` counts as
`python`.

| Program | Language |
| --- | --- |
| `python`, `pypy` | `python` |
| `node`, `nodejs`, `bun` | `javascript` |
| `deno`, `ts-node`, `tsx` | `typescript` |
| `sh`, `bash`, `zsh`, `dash`, `ash`, `ksh`, `mksh`, `busybox` | `shell`, with that dialect |
| `fish` | `fish` |
| `ruby`, `jruby` | `ruby` |
| `perl` | `perl` |
| `lua`, `luajit` | `lua` |
| `php` | `php` |
| `pwsh` | `powershell` |
| `elixir`, `swift`, `groovy`, `julia` | that language |
| `Rscript` | `r` |

Any other program leaves the file without a language. So does a launcher
that can run anything, such as `uv run`.

### `files` patterns

Use `files` for files that pi-lens cannot place by name or first line, such
as dotfiles.

- A pattern without a `/` matches the file name: `.zshrc`, `*.zsh-theme`.
- A pattern with a `/` matches the end of the path: `functions/*` matches
  `~/.zsh/functions/prompt_setup`.
- A pattern that starts with `/` matches the whole path.

pi-lens checks patterns before the language, so a `files` match wins over
the file's extension.

## The `lsp` setting

`lsp` chooses the primary language server for the language.

| Field | Meaning |
| --- | --- |
| `server` | The one language server for those files, by id. |
| `enabled` | `false` means no language server for those files. |

- The server you name attaches to those files, whatever their extensions. Its
  diagnostics decide whether pi-lens reports the file as clean.
- Other language servers do not attach to those files.
- Scanners such as `typos` and `opengrep` are not language servers. They keep
  their own rules, and you cannot name them here.
- An `lsp` entry with neither field keeps the automatic choice.

Some server ids differ from the server's name:

| Language | Server ids |
| --- | --- |
| `python` | `python` (Pyright or basedpyright), `python-jedi` |
| `typescript`, `javascript` | `typescript`, `deno` |
| `shell` | `bash` (`.sh`, `.bash`), `shuck` (`.zsh`) |
| `csharp` | `csharp`, `omnisharp` |
| `elixir` | `elixir`, `expert` |
| `dockerfile` | `docker`, `docker-official` |
| `c`, `cpp` | `cpp` (clangd) |

For most other languages the server id is the language name, such as `go`,
`rust`, or `lua`. [Server capabilities](servercapabilities.md) lists every
id. Your own `lsp.servers` entries use the id you gave them.

## The `lint` setting

`lint` chooses the linters for the language.

| Field | Meaning |
| --- | --- |
| `tools` | The linters, by runner id, in the order you prefer them. |
| `mode` | `all` runs every listed linter. `fallback` runs the first listed linter that is installed. |
| `enabled` | `false` means no linters for those files. |

- Linters you do not list do not run, and pi-lens never starts them. Its
  report says they were `not-configured-for-language`.
- A listed linter runs even when the project's config files would pick
  another one.
- A listed linter also runs when the file's primary language server already
  covers it. For example, shuck covers ShellCheck, so pi-lens normally skips
  ShellCheck for zsh files. Listing `shellcheck` turns it back on.
- With `fallback`, pi-lens tries the linters in your order. If the first one
  is not installed, it tries the next.
- If you list more than one tool and leave out `mode`, pi-lens runs them all
  and shows a warning asking you to set `mode`.
- A `lint` entry with only `mode` keeps the automatic choice of linters.
- The setting affects only linters. Tree-sitter rules, fact rules, and the
  security and dependency scanners run as before, and you cannot list them
  here.

The list chooses among the linters pi-lens already runs for that language. It
does not add a linter to a language that pi-lens does not lint with it.

These runner ids differ from the tool's name:

| Tool | Runner id |
| --- | --- |
| Biome (lint) | `biome-check-json` |
| Ruff (lint) | `ruff-lint` |
| Clippy | `rust-clippy` |
| cppcheck | `cpp-check` |
| `dart analyze` | `dart-analyze` |
| `gleam check` | `gleam-check` |
| `fish_indent` (check) | `fish-indent` |

Most other linters use the tool's name, such as `eslint`, `oxlint`,
`shellcheck`, `golangci-lint`, `rubocop`, `mypy`, or `markdownlint`.
[Language coverage](language-coverage.md) lists the runners for each
language.

Linters run only on files that pi-lens recognizes by extension or file name.
A file that matches only through `files`, such as `.zshrc`, or only through
its first line, such as `bin/deploy`, gets no linters yet. The `lsp` and
`format` settings do apply to those files.

## The `format` setting

`format` chooses the formatter for the language.

| Field | Meaning |
| --- | --- |
| `formatter` | The one formatter for those files, by name. |
| `enabled` | `false` means pi-lens does not format those files. |

- pi-lens formats with the named formatter only, whatever extensions it
  normally handles. For example, shfmt normally handles only `.sh` and
  `.bash`, and `format` can apply it to zsh files too.
- pi-lens does not look for formatter config files, and does not use its own
  default, for those files.
- If the formatter is not installed, pi-lens does not format those files. It
  does not switch to another formatter.
- A `format` entry with neither field keeps the automatic choice.

Write each formatter by its name, such as `prettier`, `biome`, `ruff`,
`shfmt`, `rustfmt`, or `gofmt`. [Language coverage](language-coverage.md)
lists the formatters for each language.

## The `autofix` setting

`autofix` chooses the tools that fix lint findings in the file after pi
writes it.

| Field | Meaning |
| --- | --- |
| `tools` | The fixers, by name, in the order they run. |
| `enabled` | `false` means pi-lens does not autofix those files. |

- pi-lens runs each listed fixer in your order, if it can find it. It does
  not run any other fixer for those files.
- If you leave out `autofix` but set `lint`, autofix uses your linters'
  fixers. A linter that cannot fix, such as `mypy` or `shellcheck`, fixes
  nothing. If `lint` runs no linters, nothing fixes the file either.
- If you set neither, autofix keeps the automatic choice.
- An `autofix` entry with neither field keeps that choice too.

The fixers are `eslint`, `oxlint`, `biome`, `ruff`, `stylelint`,
`sqlfluff`, `rubocop`, `ktlint`, `ktfmt`, `rust-clippy`, `dart-analyze`,
`golangci-lint`, `detekt`, and `markdownlint`. Only fixers that pi-lens
considers safe to run on every write can be listed.

`autofix.enabled: true` cannot turn autofix on when it is off for the whole
machine or project (`autofix.enabled: false` at the top level, or the
`--no-autofix` flag). A per-language setting can only turn fixing off.

## Where to put it, and which file wins

pi-lens reads `languages` from the same config files as every other setting:

| File | Applies to |
| --- | --- |
| `~/.pi-lens/config.json` | Every project on this machine. |
| `.pi-lens.json` at the project root | That project. |
| `.pi-lens.json` in a subfolder | Files in that subfolder. |

pi-lens combines the files one field at a time. For each field, the file
nearest to the edited file wins, and the other fields still come from the
other files. For example:

```jsonc
// ~/.pi-lens/config.json
{ "languages": { "python": { "lsp": { "enabled": false } }, "zsh": { "lsp": { "server": "shuck" } } } }

// my-project/.pi-lens.json
{ "languages": { "python": { "lsp": { "enabled": true, "server": "python-jedi" } } } }
```

In `my-project`, Python files use `python-jedi`: the project sets both fields.
zsh files use shuck from the global file, because the project does not set
`zsh`.

If the project set only `"server": "python-jedi"`, Python would still get no
language server. The global `"enabled": false` would still apply, because the
project does not set `enabled`.

A list (`files`, `lint.tools`, `autofix.tools`) is one field: the nearest
file that sets it supplies the whole list. pi-lens never merges two lists.

### When a change takes effect

- `lint`, `format`, and `autofix` changes apply from the next file pi-lens
  checks. You do not need to restart. This includes a config file you edit
  outside pi.
- `lsp` changes apply when pi-lens next loads the workspace, which is the
  next session. pi-lens reads language server settings once per workspace.

### What still wins over `languages`

- `lsp.disabledServers` turns a server off even when `languages` names it.
- `dispatch.disabledRunners` turns a linter off even when `languages` lists
  it.
- The `--no-lsp` flag turns every language server off.
- The top-level `autofix.enabled: false`, and the `--no-autofix` flag, turn
  autofix off for every language.

### Project trust

A project's `.pi-lens.json` can set `languages` without pi marking the
project trusted. `languages` only picks among tools that already exist, and
it cannot add a command to run. A tool that runs project code still needs
trust before it starts.

## Checking what applies to a file

Ask the `effective_config` tool about a file. The `languagePolicy` part of the
answer shows which entry applied and why:

```jsonc
"languagePolicy": {
  "key": "zsh",
  "via": "language",          // or "files" when a pattern matched
  "languageSource": "name",   // or "shebang" for an extensionless script
  "dialect": { "dialect": "zsh", "source": "shebang" },
  "domains": { "lsp": { "server": "shuck" }, "format": { "formatter": "shfmt" } },
  "decidedBy": { "tier": "project", "file": "~/my-project/.pi-lens.json" }
}
```

Each server in the answer has a reason. `configured-for-language` means the
`lsp` setting attached it. `not-configured-for-language` means the setting
left it out. Each linter in the answer's `tools` list has a reason too. A
linter that `lint.tools` leaves out shows `not-configured-for-language`, with
the file that set the list.

## Mistakes pi-lens reports

pi-lens shows a `PILENS_CFG_0005` warning that names the setting for each of
these:

| You wrote | What happens |
| --- | --- |
| A name that is not a language, such as `jsts` or `shell:zsh` | pi-lens ignores the whole entry. |
| A `server` that does not exist | That language gets no language server. |
| A scanner as the `server`, such as `typos` | That language gets no language server. |
| A linter id that does not exist | pi-lens removes that id from `lint.tools`. |
| A runner that is not a linter, such as `tree-sitter` | pi-lens removes that id from `lint.tools`. |
| Several `lint.tools` without a `mode` | pi-lens runs them all. |
| A `formatter` that does not exist | pi-lens does not format that language. |
| A fixer in `autofix.tools` that does not exist, or that is not safe | pi-lens removes it from `autofix.tools`. |

pi-lens does not silently go back to the automatic choice when a `server` or
a `formatter` is wrong. `effective_config` shows a wrong server as
`unusable: true`. If pi-lens removes every id from `lint.tools`, that
language gets no linters.
