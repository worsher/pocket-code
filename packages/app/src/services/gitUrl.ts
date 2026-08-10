/** Remove userinfo before persisting a remote URL in catalog or .git/config. */
export function sanitizeGitRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*:\/\/)/i);
  if (!scheme) return trimmed;

  const authorityStart = scheme[0].length;
  const suffixOffset = trimmed.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = suffixOffset === -1 ? trimmed.length : authorityStart + suffixOffset;
  const authority = trimmed.slice(authorityStart, authorityEnd);
  const userinfoEnd = authority.lastIndexOf("@");
  if (userinfoEnd === -1) return trimmed;

  return `${trimmed.slice(0, authorityStart)}${authority.slice(userinfoEnd + 1)}${trimmed.slice(authorityEnd)}`;
}
