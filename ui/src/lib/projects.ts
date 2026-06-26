import type { Project } from '../types/app';

export function isGeneralProject(project: Project | null | undefined): boolean {
  if (!project) return false;
  if (project.isGeneral === true) return true;
  const name = typeof project.name === 'string' ? project.name.trim().toLowerCase() : '';
  const displayName = typeof project.displayName === 'string' ? project.displayName.trim().toLowerCase() : '';
  return name === 'general' || displayName === 'general';
}
