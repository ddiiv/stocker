// El dueño de la cuenta (business) siempre tiene acceso total.
// Los empleados dependen de `permisos` cargados en su perfil.
export function canView(user, moduleKey) {
  if (!user) return false;
  if (user.type === "business") return true;
  const level = user.permisos?.[moduleKey];
  return level === "ver" || level === "editar";
}

export function canEdit(user, moduleKey) {
  if (!user) return false;
  if (user.type === "business") return true;
  return user.permisos?.[moduleKey] === "editar";
}
