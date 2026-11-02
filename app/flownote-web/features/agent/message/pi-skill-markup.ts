export interface PiSkillMarkup {
  names: string[];
  content: string;
}

/**
 * Pi expands `/skill:<name>` in native history into a `<skill>` element whose
 * body contains the full skill instructions. Keep that internal prompt out of
 * the chat bubble while retaining a compact reference to the invoked skill.
 */
export function hidePiSkillInstructions(content: string): PiSkillMarkup {
  const names: string[] = [];
  const visibleContent = content.replace(
    /<skill\b([^>]*)>([\s\S]*?)<\/skill\s*>/gi,
    (block, attributes: string) => {
      const name = readQuotedAttribute(attributes, "name");
      const location = readQuotedAttribute(attributes, "location")
        ?.replace(/\\/g, "/");
      if (!name || !isPiSkillName(name) || !location || !isSkillLocation(location, name)) {
        return block;
      }
      names.push(name);
      return " ";
    },
  );

  return {
    names,
    content: names.length > 0
      ? visibleContent.replace(/^\s+|\s+$/g, "")
      : content,
  };
}

function readQuotedAttribute(attributes: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
    .exec(attributes);
  return match?.[1] ?? match?.[2];
}

function isPiSkillName(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isSkillLocation(location: string, name: string): boolean {
  const segments = location.split("/").filter(Boolean);
  return segments.length >= 2 &&
    segments[segments.length - 2] === name &&
    segments[segments.length - 1].toLowerCase() === "skill.md";
}
