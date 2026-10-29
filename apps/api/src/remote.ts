/** Where a sprite clones an env's repo from; the one place that decides the git remote. */
export function cloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
