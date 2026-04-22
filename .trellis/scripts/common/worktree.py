#!/usr/bin/env python3
"""
Legacy worktree compatibility helpers.

The 0.5.x migration removed the old Multi-Agent Pipeline and its
`.trellis/worktree.yaml` file. This module keeps a tiny compatibility surface
for callers that still import these helpers:

- `get_agents_dir()` remains active and is used by the registry helpers.
- Legacy worktree config accessors now return safe defaults instead of reading
  a deleted config file.
"""

from __future__ import annotations

from pathlib import Path

from .paths import (
    DIR_WORKFLOW,
    get_repo_root,
    get_workspace_dir,
)

WORKTREE_CONFIG_PATH = f"{DIR_WORKFLOW}/worktree.yaml"
DEFAULT_WORKTREE_BASE_DIR = "../worktrees"


def get_worktree_config(repo_root: Path | None = None) -> Path:
    """Get the historical worktree config path.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Absolute path to the removed legacy config file location.
    """
    if repo_root is None:
        repo_root = get_repo_root()
    return repo_root / WORKTREE_CONFIG_PATH


def get_worktree_base_dir(repo_root: Path | None = None) -> Path:
    """Get the legacy default worktree base directory.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Absolute path to the legacy default base directory.
    """
    if repo_root is None:
        repo_root = get_repo_root()
    return (repo_root / DEFAULT_WORKTREE_BASE_DIR).resolve()


def get_worktree_copy_files(repo_root: Path | None = None) -> list[str]:
    """Get legacy copy-file declarations.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Empty list. Legacy copy rules were removed with worktree.yaml.
    """
    return []


def get_worktree_post_create_hooks(repo_root: Path | None = None) -> list[str]:
    """Get legacy worktree post-create hooks.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Empty list. Legacy post-create hooks were removed with worktree.yaml.
    """
    return []


# =============================================================================
# Agents Registry
# =============================================================================

def get_agents_dir(repo_root: Path | None = None) -> Path | None:
    """Get agents directory for current developer.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Absolute path to agents directory, or None if no workspace.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    workspace_dir = get_workspace_dir(repo_root)
    if workspace_dir:
        return workspace_dir / ".agents"
    return None


# =============================================================================
# Main Entry (for testing)
# =============================================================================

if __name__ == "__main__":
    repo = get_repo_root()
    print(f"Repository root: {repo}")
    print(f"Legacy worktree config path: {get_worktree_config(repo)}")
    print(f"Legacy worktree base dir: {get_worktree_base_dir(repo)}")
    print(f"Legacy copy files: {get_worktree_copy_files(repo)}")
    print(f"Legacy post-create hooks: {get_worktree_post_create_hooks(repo)}")
    print(f"Agents dir: {get_agents_dir(repo)}")
