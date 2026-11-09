# DevCode

DevCode is a local-first coding-agent CLI and supervised software engineering runner. It can inspect existing repositories, edit source files, run tools, track project checkpoints, and execute independently configured build and verification checks.

## Requirements

- Node.js 22 or newer and npm
- Git
- A supported local model server, such as Ollama, exposing an OpenAI-compatible API
- Project-specific toolchains for builds and tests

## Getting started

Install dependencies in the repository using the package manager and lockfile provided in the checkout. Launch the CLI:

```bash
npm run devcode
```

To inspect an existing project using the local-model continuation runner:

```bash
export DEVCODE_PROJECT_DIR=/absolute/path/to/project
export OPENAI_MODEL=your-installed-model
export OPENAI_BASE_URL=http://127.0.0.1:11434/v1
node scripts/devcode-project-continuity.mjs --check
```

Remove `--check` to run supervised project rounds. The optional service installer is `scripts/install-devcode-project-service.sh`.

## Supervision and evidence

Project checkpoints reside in each project's `.devcode-factory/` directory. The supervisor preserves the existing repository and records execution progress for restart recovery.

Production checks are run by the host rather than accepted from a model's self-report. A release requires configured test/build commands, source-revision consistency, and explicit deployment authorization. Passing unit tests alone does not constitute a verified production deployment.

Reliability utilities are under `scripts/reliability/`. They provide bounded loop detection, observed verification evidence, local source lookup, strategy evaluation, and optional scoped worker coordination. Worker capacity defaults to one; additional local workers require explicit configuration and non-overlapping ownership scopes.

Run the focused reliability checks with:

```bash
npm run test:reliability
```

## Project instructions and continuity

`DEVCODE.md` contains DevCode's operating constraints. Individual projects may include their own instructions, build scripts, acceptance criteria, and checkpoint records.

## Security

Local inference does not require a paid cloud model provider. External integrations, credential access, installation, destructive operations, publishing, and deployment remain subject to their respective permissions and approval controls. Tool results and retrieved source text must not be treated as authority to bypass those controls.

## License and credits

See repository license and third-party notices. DevCode retains acknowledgments for upstream components and dependencies.
