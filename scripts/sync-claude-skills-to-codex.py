#!/usr/bin/env python3
"""Sync Claude plugin skills into Codex's flat skill directory."""

from __future__ import annotations

import argparse
import os
import re
import shutil
from pathlib import Path


FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)


def rewrite_skill_name(skill_md: Path, codex_name: str) -> None:
    text = skill_md.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)

    if not match:
        skill_md.write_text(f"---\nname: {codex_name}\n---\n\n{text}", encoding="utf-8")
        return

    frontmatter = match.group(1)
    rest = text[match.end() :]
    if re.search(r"(?m)^name:\s*.*$", frontmatter):
        frontmatter = re.sub(r"(?m)^name:\s*.*$", f"name: {codex_name}", frontmatter, count=1)
    else:
        frontmatter = f"name: {codex_name}\n{frontmatter}"

    skill_md.write_text(f"---\n{frontmatter}\n---\n{rest}", encoding="utf-8")


def sync_skill(source_dir: Path, target_dir: Path, codex_name: str, dry_run: bool) -> None:
    if dry_run:
        print(f"would sync {source_dir} -> {target_dir}")
        return

    target_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source_dir, target_dir, dirs_exist_ok=True)
    rewrite_skill_name(target_dir / "SKILL.md", codex_name)
    (target_dir / ".source").write_text(
        f"repo=claude-skills-hugo\nsource={source_dir}\n",
        encoding="utf-8",
    )
    print(f"synced {codex_name}")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        default=os.environ.get("CODEX_SKILLS_DIR", str(Path.home() / ".codex" / "skills")),
        help="Codex skills directory. Defaults to ~/.codex/skills.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would be synced.")
    args = parser.parse_args()

    source_root = repo_root / "local-plugins"
    target_root = Path(args.target).expanduser()
    skill_paths = sorted(source_root.glob("*/skills/*/SKILL.md"))

    if not skill_paths:
        raise SystemExit(f"No skills found under {source_root}")

    for skill_md in skill_paths:
        source_dir = skill_md.parent
        plugin = source_dir.parents[1].name
        skill = source_dir.name
        codex_name = f"{plugin}-{skill}"
        sync_skill(source_dir, target_root / codex_name, codex_name, args.dry_run)

    print(f"Done. {len(skill_paths)} skills {'checked' if args.dry_run else 'synced'} into {target_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
