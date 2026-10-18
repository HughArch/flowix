/** Pi skill names are used in `/skill:<name>` commands and Skill frontmatter. */
export function isValidPiSkillCommandName(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
