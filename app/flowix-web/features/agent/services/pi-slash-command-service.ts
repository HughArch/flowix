import type { ComposerSlashSkill } from "@features/agent/thread-card/composer/composer-slash-command-controller";
import { agent } from "@platform/tauri/client/agent";
import { isValidPiSkillCommandName } from "./pi-skill-name";

/** Read notebook skills for Pi's composer without starting an agent turn. */
export async function listPiSkills(cwd: string): Promise<readonly ComposerSlashSkill[]> {
  if (!cwd.trim()) return [];
  const skills = await agent.readNotebookAgentSkills(cwd);
  return skills
    .map((skill) => ({
      skill,
      declaredName: skill.frontmatter.name?.trim() ?? "",
      commandName: skill.commandName?.trim() || skill.id,
    }))
    .filter(({ skill, declaredName, commandName }) =>
      skill.enabled &&
      skill.description.trim() &&
      declaredName === commandName &&
      skill.path.replace(/\\/g, "/").endsWith("/SKILL.md") &&
      isValidPiSkillCommandName(commandName),
    )
    .map(({ skill, commandName }) => ({
      name: commandName,
      description: skill.description,
      displayName: skill.name.trim() || commandName,
      scope: "workspace",
    }));
}
