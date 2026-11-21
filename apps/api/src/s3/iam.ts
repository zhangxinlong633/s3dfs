import { randomBytes } from 'node:crypto';
import { S3HttpError } from './multipart';
import type { PolicyStatement } from './product';

export interface IamKv {
  get(key: string): Promise<{ value: Buffer } | null>;
  put(key: string, value: Buffer): Promise<void>;
  delete(key: string): Promise<boolean>;
  scan(prefix: string): Promise<string[]>;
}

interface PolicyRecord {
  statements: PolicyStatement[];
}

interface UserRecord {
  secretAccessKey: string;
  status: 'enabled' | 'disabled';
  groups: string[];
  policies: string[];
}

interface GroupRecord {
  members: string[];
  policies: string[];
}

interface SessionRecord {
  secretAccessKey: string;
  parent: string;
  status: 'enabled' | 'disabled';
  expiresAtMs?: number;
  policies?: string[];
}

export interface IamGrant {
  secretAccessKey: string;
  parent: PolicyStatement[];
  session?: PolicyStatement[];
}

export interface IamCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  expiresAtMs?: number;
}

type IamOp = {
  op: string;
  name?: string;
  statements?: PolicyStatement[];
  members?: string[];
  policies?: string[];
  accessKeyId?: string;
  secretAccessKey?: string;
  status?: 'enabled' | 'disabled';
  groups?: string[];
  parent?: string;
  expiresAtMs?: number;
  durationSeconds?: number;
  now?: number;
};

export class IamDirectory {
  constructor(private readonly kv: IamKv) {}

  async apply(input: IamOp): Promise<IamCredentials | { ok: true }> {
    switch (input.op) {
      case 'putPolicy':
        await this.putPolicy(required(input.name, 'name'), input.statements ?? []);
        return { ok: true };
      case 'deletePolicy':
        await this.deletePolicy(required(input.name, 'name'));
        return { ok: true };
      case 'putGroup':
        await this.putGroup(required(input.name, 'name'), input.members ?? [], input.policies ?? []);
        return { ok: true };
      case 'deleteGroup':
        await this.deleteGroup(required(input.name, 'name'));
        return { ok: true };
      case 'putUser':
        await this.putUser({
          accessKeyId: required(input.accessKeyId, 'accessKeyId'),
          secretAccessKey: required(input.secretAccessKey, 'secretAccessKey'),
          status: input.status ?? 'enabled',
          groups: input.groups ?? [],
          policies: input.policies ?? [],
        });
        return { ok: true };
      case 'deleteUser':
        await this.deleteUser(required(input.accessKeyId, 'accessKeyId'));
        return { ok: true };
      case 'setUserStatus':
        await this.setUserStatus(required(input.accessKeyId, 'accessKeyId'), input.status ?? 'enabled');
        return { ok: true };
      case 'createServiceAccount':
        return this.createSession(required(input.parent, 'parent'), input.policies, input.expiresAtMs);
      case 'deleteServiceAccount':
        await this.kv.delete(sessionKey(required(input.accessKeyId, 'accessKeyId')));
        return { ok: true };
      case 'assumeRole':
        return this.assumeRole(required(input.parent, 'parent'), input.durationSeconds, input.policies, input.now ?? Date.now());
      default:
        throw new S3HttpError(400, 'InvalidArgument', 'Unknown iam op');
    }
  }

  async resolve(accessKeyId: string, now: number): Promise<IamGrant | 'disabled' | 'expired' | null> {
    const user = await this.readUser(accessKeyId);
    if (user) {
      if (user.status === 'disabled') {
        return 'disabled';
      }
      return { secretAccessKey: user.secretAccessKey, parent: await this.statementsFor(user) };
    }
    const session = await this.readSession(accessKeyId);
    if (!session) {
      return null;
    }
    if (session.status === 'disabled' || (session.expiresAtMs != null && now >= session.expiresAtMs)) {
      return 'expired';
    }
    const parent = await this.readUser(session.parent);
    if (!parent || parent.status === 'disabled') {
      return 'disabled';
    }
    const grant: IamGrant = { secretAccessKey: session.secretAccessKey, parent: await this.statementsFor(parent) };
    if (session.policies) {
      grant.session = await this.statementsNamed(session.policies);
    }
    return grant;
  }

  private async putPolicy(name: string, statements: PolicyStatement[]): Promise<void> {
    await this.kv.put(policyKey(name), json({ statements }));
  }

  private async deletePolicy(name: string): Promise<void> {
    const attached = await this.policyAttached(name);
    if (attached) {
      throw new S3HttpError(409, 'Conflict', 'Policy is still attached');
    }
    await this.kv.delete(policyKey(name));
  }

  private async putGroup(name: string, members: string[], policies: string[]): Promise<void> {
    await this.statementsNamed(policies);
    const previous = await this.readGroup(name);
    for (const member of members) {
      if (!(await this.readUser(member))) {
        throw new S3HttpError(400, 'InvalidArgument', 'Unknown user');
      }
    }
    const removed = (previous?.members ?? []).filter((member) => !members.includes(member));
    const added = members.filter((member) => !(previous?.members ?? []).includes(member));
    for (const member of removed) {
      const user = await this.readUser(member);
      if (user) {
        user.groups = user.groups.filter((group) => group !== name);
        await this.kv.put(userKey(member), json(user));
      }
    }
    for (const member of added) {
      const user = await this.readUser(member);
      if (user && !user.groups.includes(name)) {
        user.groups.push(name);
        await this.kv.put(userKey(member), json(user));
      }
    }
    await this.kv.put(groupKey(name), json({ members, policies }));
  }

  private async deleteGroup(name: string): Promise<void> {
    const group = await this.readGroup(name);
    if (!group) {
      return;
    }
    for (const member of group.members) {
      const user = await this.readUser(member);
      if (user) {
        user.groups = user.groups.filter((item) => item !== name);
        await this.kv.put(userKey(member), json(user));
      }
    }
    await this.kv.delete(groupKey(name));
  }

  private async putUser(user: UserRecord & { accessKeyId: string }): Promise<void> {
    await this.statementsNamed(user.policies);
    for (const group of user.groups) {
      if (!(await this.readGroup(group))) {
        throw new S3HttpError(400, 'InvalidArgument', 'Unknown group');
      }
    }
    const previous = await this.readUser(user.accessKeyId);
    const removed = (previous?.groups ?? []).filter((group) => !user.groups.includes(group));
    const added = user.groups.filter((group) => !(previous?.groups ?? []).includes(group));
    for (const group of removed) {
      const record = await this.readGroup(group);
      if (record) {
        record.members = record.members.filter((member) => member !== user.accessKeyId);
        await this.kv.put(groupKey(group), json(record));
      }
    }
    for (const group of added) {
      const record = await this.readGroup(group);
      if (record && !record.members.includes(user.accessKeyId)) {
        record.members.push(user.accessKeyId);
        await this.kv.put(groupKey(group), json(record));
      }
    }
    await this.kv.put(userKey(user.accessKeyId), json({
      secretAccessKey: user.secretAccessKey,
      status: user.status,
      groups: user.groups,
      policies: user.policies,
    }));
  }

  private async deleteUser(accessKeyId: string): Promise<void> {
    const user = await this.readUser(accessKeyId);
    if (user) {
      for (const group of user.groups) {
        const record = await this.readGroup(group);
        if (record) {
          record.members = record.members.filter((member) => member !== accessKeyId);
          await this.kv.put(groupKey(group), json(record));
        }
      }
    }
    for (const key of await this.kv.scan('$iam/session/')) {
      const session = await this.readSession(key.slice('$iam/session/'.length));
      if (session?.parent === accessKeyId) {
        await this.kv.delete(key);
      }
    }
    await this.kv.delete(userKey(accessKeyId));
  }

  private async setUserStatus(accessKeyId: string, status: 'enabled' | 'disabled'): Promise<void> {
    const user = await this.readUser(accessKeyId);
    if (!user) {
      throw new S3HttpError(400, 'InvalidArgument', 'Unknown user');
    }
    user.status = status;
    await this.kv.put(userKey(accessKeyId), json(user));
  }

  private async createSession(parent: string, policies: string[] | undefined, expiresAtMs?: number): Promise<IamCredentials> {
    const user = await this.readUser(parent);
    if (!user || user.status === 'disabled') {
      throw new S3HttpError(400, 'InvalidArgument', 'Unknown user');
    }
    if (policies) {
      await this.statementsNamed(policies);
    }
    const accessKeyId = `AKIA${randomBytes(8).toString('hex')}`;
    const secretAccessKey = randomBytes(20).toString('hex');
    const session: SessionRecord = { secretAccessKey, parent, status: 'enabled' };
    if (expiresAtMs != null) {
      session.expiresAtMs = expiresAtMs;
    }
    if (policies) {
      session.policies = policies;
    }
    await this.kv.put(sessionKey(accessKeyId), json(session));
    return { accessKeyId, secretAccessKey, expiresAtMs };
  }

  private async assumeRole(parent: string, durationSeconds: number | undefined, policies: string[] | undefined, now: number): Promise<IamCredentials> {
    const duration = Math.min(Math.max(durationSeconds ?? 3600, 1), 43200);
    return this.createSession(parent, policies, now + duration * 1000);
  }

  private async statementsFor(user: UserRecord): Promise<PolicyStatement[]> {
    const names = [...user.policies];
    for (const group of user.groups) {
      const record = await this.readGroup(group);
      if (record) {
        names.push(...record.policies);
      }
    }
    return this.statementsNamed(names);
  }

  private async statementsNamed(names: string[]): Promise<PolicyStatement[]> {
    const statements: PolicyStatement[] = [];
    for (const name of names) {
      const policy = await this.readPolicy(name);
      if (!policy) {
        throw new S3HttpError(400, 'InvalidArgument', 'Unknown policy');
      }
      statements.push(...policy.statements);
    }
    return statements;
  }

  private async policyAttached(name: string): Promise<boolean> {
    for (const prefix of ['$iam/user/', '$iam/group/', '$iam/session/']) {
      for (const key of await this.kv.scan(prefix)) {
        const got = await this.kv.get(key);
        const policies = got ? (JSON.parse(got.value.toString('utf8')) as { policies?: string[] }).policies : undefined;
        if (policies?.includes(name)) {
          return true;
        }
      }
    }
    return false;
  }

  private async readPolicy(name: string): Promise<PolicyRecord | null> {
    return readJson<PolicyRecord>(await this.kv.get(policyKey(name)));
  }

  private async readUser(accessKeyId: string): Promise<UserRecord | null> {
    return readJson<UserRecord>(await this.kv.get(userKey(accessKeyId)));
  }

  private async readGroup(name: string): Promise<GroupRecord | null> {
    return readJson<GroupRecord>(await this.kv.get(groupKey(name)));
  }

  private async readSession(accessKeyId: string): Promise<SessionRecord | null> {
    return readJson<SessionRecord>(await this.kv.get(sessionKey(accessKeyId)));
  }
}

export function grantAllows(grant: IamGrant, action: string, resource: string): boolean {
  if (!permits(grant.parent, action, resource)) {
    return false;
  }
  if (grant.session && !permits(grant.session, action, resource)) {
    return false;
  }
  return true;
}

function permits(statements: PolicyStatement[], action: string, resource: string): boolean {
  const matched = statements.filter((statement) => actionMatches(statement.action, action) && resourceMatches(statement.resource, resource));
  if (matched.some((statement) => statement.effect === 'Deny')) {
    return false;
  }
  return matched.some((statement) => statement.effect === 'Allow');
}

function actionMatches(rule: string, action: string): boolean {
  return rule === '*' || rule === 's3:*' || rule === action;
}

function resourceMatches(rule: string, resource: string): boolean {
  const pattern = rule.replace(/^arn:aws:s3:::/, '');
  if (pattern === '*' || pattern === resource) {
    return true;
  }
  if (pattern.endsWith('*')) {
    return resource.startsWith(pattern.slice(0, -1));
  }
  return false;
}

function policyKey(name: string): string {
  return `$iam/policy/${name}`;
}

function groupKey(name: string): string {
  return `$iam/group/${name}`;
}

function userKey(accessKeyId: string): string {
  return `$iam/user/${accessKeyId}`;
}

function sessionKey(accessKeyId: string): string {
  return `$iam/session/${accessKeyId}`;
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function readJson<T>(got: { value: Buffer } | null): T | null {
  return got ? (JSON.parse(got.value.toString('utf8')) as T) : null;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new S3HttpError(400, 'InvalidArgument', `Missing ${name}`);
  }
  return value;
}
