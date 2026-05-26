// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { api, flashStatus, showError } from "./api.js";
import { insertCommand } from "./commands.js";
import { renderCommands } from "./commands.js";

export async function loadSkills() {
  const result = await api("/api/skills");
  state.skills = result.skills || [];
  renderSkills();
}

export async function reloadSkills() {
  try {
    const sessionId = state.session?.sessionId;
    const body = sessionId ? { sessionId } : {};
    const result = await api("/api/skills/refresh", { method: "POST", body });
    if (Array.isArray(result.commands)) {
      state.commands = result.commands;
      renderCommands();
    }
    if (Array.isArray(result.skills)) {
      state.skills = result.skills;
      renderSkills();
    } else {
      await loadSkills();
    }
    const count = Array.isArray(result.skills) ? result.skills.length : state.skills.length;
    flashStatus(`Reloaded ${count} skill${count === 1 ? "" : "s"}.`);
  } catch (error) {
    showError(error);
  }
}

export function renderSkills() {
  els.skillList.innerHTML = View.renderSkillsHTML(state.skills);
  els.skillList.querySelectorAll("[data-skill]").forEach((button) => {
    button.addEventListener("click", () => openSkillEditor(state.skills.find((skill) => skill.slug === button.dataset.skill)));
  });
  els.skillList.querySelectorAll("[data-use-skill]").forEach((button) => {
    button.addEventListener("click", () => insertCommand(button.dataset.useSkill));
  });
  renderCommands();
}

export function openSkillEditor(skill) {
  const isNew = !skill;
  els.skillDialogTitle.textContent = isNew ? "New skill" : `Edit ${skill.name}`;
  els.skillSlugInput.value = skill?.slug || "";
  els.skillNameInput.value = skill?.name || "";
  els.skillDescriptionInput.value = skill?.description || "";
  els.skillContentInput.value =
    skill?.content ||
    `---\nname: ${skill?.name || "new-skill"}\ndescription: Describe when this skill should be used.\n---\n\n# ${skill?.name || "New Skill"}\n\nDescribe the workflow here.\n`;
  els.deleteSkill.style.display = isNew ? "none" : "inline-flex";
  els.skillDialog.showModal();
}

export async function saveSkill(event) {
  event.preventDefault();
  const slug = els.skillSlugInput.value;
  const body = {
    name: els.skillNameInput.value.trim(),
    description: els.skillDescriptionInput.value.trim(),
    content: els.skillContentInput.value,
  };
  if (slug) {
    await api(`/api/skills/${encodeURIComponent(slug)}`, { method: "PUT", body });
  } else {
    await api("/api/skills", { method: "POST", body });
  }
  els.skillDialog.close();
  await loadSkills();
}

export async function deleteSkill() {
  const slug = els.skillSlugInput.value;
  if (!slug) return;
  await api(`/api/skills/${encodeURIComponent(slug)}`, { method: "DELETE", body: {} });
  els.skillDialog.close();
  await loadSkills();
}
