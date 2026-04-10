/** Map file extensions to highlight.js language identifiers */
const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  md: "markdown",
  mdx: "markdown",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  php: "php",
  r: "r",
  dart: "dart",
  vue: "html",
  svelte: "html",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  proto: "protobuf",
};

/** Special filenames that map to specific languages */
const NAME_MAP: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Containerfile: "dockerfile",
  ".gitignore": "bash",
  ".env": "bash",
  ".env.local": "bash",
  ".env.example": "bash",
};

/**
 * Detect highlight.js language from filename.
 * Returns "plaintext" if unknown.
 */
export function detectLanguage(filename: string): string {
  // Check special filenames first
  const baseName = filename.split("/").pop() || filename;
  if (NAME_MAP[baseName]) return NAME_MAP[baseName];

  // Check extension
  const ext = baseName.split(".").pop()?.toLowerCase() || "";
  return EXT_MAP[ext] || "plaintext";
}
