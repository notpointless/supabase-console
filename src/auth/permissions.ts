import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  project: ["create", "update", "delete", "content"],
  billing: ["manage"],
} as const;

export const ac = createAccessControl(statement);

export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  project: ["create", "update", "delete", "content"],
  billing: ["manage"],
});
export const administrator = ac.newRole({
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  project: ["create", "update", "delete", "content"],
  billing: ["manage"],
});
export const developer = ac.newRole({ project: ["content"] });
