---
name: cli-anything
description: Make any CLI tool or software agent-native by creating structured wrappers, command discovery patterns, and natural language interfaces for command-line tools. Use when integrating CLI tools into Claude workflows, automating shell commands, creating agent-friendly wrappers for existing software, or building automation pipelines. Triggers when user wants Claude to use CLI tools autonomously, automate terminal workflows, or "make X work with Claude agents".
---

# CLI-Anything: Agent-Native CLI Integration

Inspired by: https://github.com/HKUDS/CLI-Anything

## Core Concept
Any CLI tool can become agent-native by providing:
1. **Discovery**: What commands exist?
2. **Intent mapping**: Natural language → command
3. **Safe execution**: Validate before run
4. **Result parsing**: Structure the output

## CLI Integration Pattern

### Step 1: Tool Discovery
```bash
# Get available commands
tool --help 2>&1 | head -50

# Get subcommand help
tool subcommand --help 2>&1

# Find examples in man page
man tool | grep -A3 "EXAMPLES"
```

### Step 2: Command Mapping Template
```python
TOOL_COMMANDS = {
    "list files": "ls -la {path}",
    "find file": "find {root} -name '{pattern}' -type f",
    "search content": "grep -r '{query}' {path}",
    "compress": "tar -czf {output}.tar.gz {input}",
    "check process": "ps aux | grep {process}",
    "kill process": "pkill -f {pattern}",
}
```

### Step 3: Safe Execution Framework
```python
DANGEROUS_PATTERNS = [
    r'rm -rf /',        # Root deletion
    r'dd if=',          # Disk operations
    r':(){ :|:& };:',   # Fork bombs
    r'> /dev/sda',      # Device writes
]

def safe_execute(command: str) -> dict:
    # 1. Check for dangerous patterns
    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, command):
            return {"error": "Dangerous command rejected", "command": command}

    # 2. Dry run if supported
    # 3. Execute with timeout
    # 4. Parse output
    result = subprocess.run(command, shell=True, capture_output=True,
                           text=True, timeout=30)
    return {
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "success": result.returncode == 0
    }
```

## Common CLI Wrappers

### Git Operations
```bash
# Status
git status --short

# Create feature branch
git checkout -b feature/{name}

# Commit with message
git add -A && git commit -m "{type}: {message}"

# Push and create PR
git push origin HEAD
gh pr create --title "{title}" --body "{body}"
```

### Docker Operations
```bash
# List containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Build image
docker build -t {name}:{tag} .

# Run with env file
docker run --env-file .env -p {host}:{container} {image}

# View logs
docker logs -f --tail 100 {container}
```

### Package Management
```bash
# Node
npm install {package}
npm run {script}
npx {command}

# Python
pip install {package} --break-system-packages
python -m {module}

# Check outdated
npm outdated
pip list --outdated
```

### Database CLIs
```bash
# PostgreSQL
psql {DATABASE_URL} -c "{query}"

# SQLite
sqlite3 {file.db} "{query}"

# Redis
redis-cli {command}
```

## Agent Workflow Integration

### Auto-discovery Pattern
When Claude encounters a new CLI tool:
1. Run `{tool} --help` or `{tool} --version`
2. Identify the most common 5-10 commands
3. Map to natural language intents
4. Create a mini-wrapper for the session

### Output Parsing
```python
def parse_cli_output(output: str, format: str = "auto") -> dict:
    """Parse CLI output into structured data"""
    if format == "json" or output.strip().startswith('{'):
        return json.loads(output)
    elif format == "table":
        return parse_table(output)  # Split by whitespace/tabs
    elif format == "lines":
        return output.strip().split('\n')
    else:
        return {"raw": output}  # Fallback
```

## Safety Guidelines
- Always show the command before executing
- For destructive operations: require explicit confirmation
- Log all executed commands
- Use `--dry-run` flags when available
- Never execute commands from untrusted sources

Pairs with **gstack** (same plugin) for scaffolding automation and **paul-loop** (same plugin) for multi-step CLI workflows.
