# @docmd/engine-python

Python-accelerated engine for docmd using Python 3 runtime.

## Overview

`@docmd/engine-python` provides an execution engine for docmd powered by Python 3. It accelerates file discovery, file reading, git log operations, and search indexing using Python's multithreaded I/O capabilities.

Unlike compiled native addons (such as Rust `.node` binaries), Python code is platform-agnostic and runs directly via the host's `python3` (or `python`) interpreter. No OS-specific pre-compiled binaries are required.

## Requirements

- Python 3.8 or higher installed on the host system (available in `PATH` as `python3` or `python`, or configured via `DOCMD_PYTHON` environment variable).
- Node.js 20.0.0 or higher.

## Usage

In your `docmd.config.json`:

```json
{
  "engine": "python"
}
```

If Python is not available on the host system, docmd will automatically fall back to the built-in JavaScript engine.

## License

MIT