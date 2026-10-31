export const STATUSES = ['new', 'in_progress', 'review', 'done'];

export const STATUS_LABELS = {
  new: 'Новая',
  in_progress: 'В работе',
  review: 'На проверке',
  done: 'Готово',
};

export const MANAGER_ONLY_STATUSES = ['done'];

export function isManager(user) {
  return user?.role === 'manager';
}

export function canViewTask(user, task) {
  if (!user || !task) return false;
  return isManager(user) || (task.assignee_id != null && task.assignee_id === user.id);
}

export function canCreateTask(user) {
  return isManager(user);
}

export function canDeleteTask(user) {
  return isManager(user);
}

export function canAssign(user) {
  return isManager(user);
}

export function canManageUsers(user) {
  return isManager(user);
}

export function canEditTaskFields(user, task) {
  return canViewTask(user, task);
}

export function canSetStatus(user, task, status) {
  if (!canViewTask(user, task)) return false;
  if (isManager(user)) return true;
  return !MANAGER_ONLY_STATUSES.includes(status);
}
