# DevCode

**DevCode is your existing autonomous engineering factory.**

It works with the code you already have. It is designed to continue projects,
not start them again when a conversation ends or a computer restarts.

## What DevCode does

- Inspect and improve existing software.
- Build new features, edit files, run checks, and repair mistakes.
- Keep a separate work record for every project.
- Start a fresh AI conversation when needed and continue from saved records.
- Use your local 30B model without cloud provider monthly request quotas.
- Optionally use approved free cloud backups for extra capacity.
- Preserve existing code and decisions. Do not erase work to reset a task.
- Require real verification before describing a product as finished.

## Main command

```bash
npm run devcode
```

For a convenient `devcode` terminal command on the ThinkPad, use the setup
script below. This changes the user-facing launcher but does not replace the
existing source or erase provider settings.

## Continue an existing project

Run these commands from your **current DevCode checkout**:

```bash
node --test scripts/tests/devcode-project-continuity.test.mjs
bash scripts/setup-devcode-on-thinkpad.sh "$HOME/Projects/jobflow"
```

The example above continues JobFlow, provided that directory actually exists.
For any other existing project, replace the last path with that project's
actual directory. The setup never creates a fresh product to replace one you
already built.

Each project stores its own continuation records inside
`.devcode-factory/`, including `mission.md`, `progress.md`,
`next-task.md`, `decisions.md`, `evidence.md`, and `blockers.md`.
Those records are not erased when the model starts a new conversation.

To check a project without changing code:

```bash
export DEVCODE_PROJECT_DIR="$HOME/Projects/jobflow"
export OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export OPENAI_MODEL="YOUR_EXISTING_LOCAL_MODEL_NAME"
node scripts/devcode-project-continuity.mjs --check
```

## Project instructions

- `DEVCODE.md` is the primary instructions file for DevCode.
- Older instruction files are still read so previously saved projects keep their
  instructions, decisions, and progress.
- Do not rename actual model IDs, internal package names, or credential paths
  without verifying that all dependent software has been updated.
- The new name must not break existing tools or settings.

## Rename remaining visible text safely

See what can be renamed without changing files:

```bash
node scripts/rebrand-devcode.mjs
```

Make those display-name changes only after reviewing them:

```bash
node scripts/rebrand-devcode.mjs --apply
git diff --check
```

This tool does not rename critical internal library identifiers, model names,
old credential folders, or third-party authorship. Those are functional
connections, not the name of your DevCode product.

## Keeping work going

Your ThinkPad can run the DevCode project continuation service. The service
restarts the runner after unexpected exits; the runner uses saved project memory
and independently retries local model outages.

No computer can have literally infinite working context, memory, electricity
or storage. The system provides *continuity* through saved knowledge and fresh
model sessions, without introducing a monthly provider request limit for local
inference.

The code is available for testing in this branch. Running on your actual
ThinkPad and completing a project still require live verification.

## Credits and history

DevCode is an independently named fork with historical upstream dependencies.
The repository retains appropriate third-party notices, upstream license
information, and compatibility with existing integrations. Renaming the
product does not change the identity or ownership of third-party technology.
