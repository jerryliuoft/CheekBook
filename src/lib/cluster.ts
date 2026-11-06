import { db, type Face, type Person } from '../db';
import { groupBy, normalized } from './util';

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

interface Group {
  personId: number | null; // existing person, or null for a new group
  sum: Float32Array;
  centroid: Float32Array;
  faceIds: number[];
}

function makeGroup(personId: number | null, faces: Face[]): Group {
  const sum = new Float32Array(faces[0].embedding.length);
  for (const f of faces) for (let i = 0; i < sum.length; i++) sum[i] += f.embedding[i];
  return { personId, sum, centroid: normalized(sum), faceIds: faces.map((f) => f.id) };
}

function addToGroup(g: Group, f: Face) {
  for (let i = 0; i < g.sum.length; i++) g.sum[i] += f.embedding[i];
  g.centroid = normalized(g.sum);
  g.faceIds.push(f.id);
}

/**
 * Assigns every ungrouped face to a person.
 * Faces join the most similar existing group (people the user already has, or
 * new groups found in this pass) when cosine similarity >= threshold;
 * otherwise they start a new group. Similar new groups are then merged.
 */
export async function groupFaces(threshold: number) {
  const byPerson = groupBy(await db.faces.toArray(), (f) => f.personId);
  const ungrouped = byPerson.get(null) ?? [];
  byPerson.delete(null);
  if (ungrouped.length === 0) return;

  const groups: Group[] = [...byPerson].map(([pid, fs]) => makeGroup(pid, fs));
  ungrouped.sort((a, b) => b.score - a.score);
  for (const f of ungrouped) {
    let best: Group | null = null;
    let bestSim = threshold;
    for (const g of groups) {
      const s = dot(f.embedding, g.centroid);
      if (s >= bestSim) {
        bestSim = s;
        best = g;
      }
    }
    if (best) addToGroup(best, f);
    else groups.push(makeGroup(null, [f]));
  }

  // Merge pass: fold new groups into any group that's now similar enough.
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.personId != null) continue;
    for (let j = 0; j < groups.length; j++) {
      if (j === i) continue;
      if (dot(g.centroid, groups[j].centroid) >= threshold) {
        const target = groups[j];
        target.faceIds.push(...g.faceIds);
        for (let k = 0; k < g.sum.length; k++) target.sum[k] += g.sum[k];
        target.centroid = normalized(target.sum);
        groups.splice(i, 1);
        break;
      }
    }
  }

  const ungroupedIds = new Set(ungrouped.map((f) => f.id));
  let newPeople = 0;
  await db.transaction('rw', db.faces, db.people, async () => {
    const count = await db.people.count();
    for (const g of groups) {
      const toAssign = g.faceIds.filter((id) => ungroupedIds.has(id));
      if (toAssign.length === 0) continue;
      let pid = g.personId;
      if (pid == null) {
        newPeople++;
        pid = (await db.people.add({
          name: `Person ${count + newPeople}`,
          coverFaceId: g.faceIds[0],
          createdAt: Date.now(),
        } as Person)) as number;
      }
      await db.faces.where('id').anyOf(toAssign).modify({ personId: pid });
    }
  });
}

/** Clears automatic grouping (keeps faces the user placed by hand) and regroups. */
export async function regroupAll(threshold: number) {
  await db.transaction('rw', db.faces, db.people, async () => {
    await db.faces.filter((f) => !f.locked).modify({ personId: null });
    await removeEmptyPeople();
  });
  await groupFaces(threshold);
}

export async function removeEmptyPeople() {
  const used = new Set((await db.faces.toArray()).map((f) => f.personId));
  const empty = (await db.people.toArray()).filter((p) => !used.has(p.id)).map((p) => p.id);
  await db.people.bulkDelete(empty);
}

export async function mergePeople(targetId: number, sourceIds: number[]) {
  await db.transaction('rw', db.faces, db.people, db.stickers, async () => {
    await db.faces.where('personId').anyOf(sourceIds).modify({ personId: targetId, locked: true });
    await db.stickers.where('personId').anyOf(sourceIds).modify({ personId: targetId });
    await db.people.bulkDelete(sourceIds);
  });
}

/** "Not this person": moves a face into its own new person. */
export async function splitFace(faceId: number) {
  await db.transaction('rw', db.faces, db.people, async () => {
    const pid = (await db.people.add({
      name: 'Unsorted',
      coverFaceId: faceId,
      createdAt: Date.now(),
    } as Person)) as number;
    await db.faces.update(faceId, { personId: pid, locked: true });
    await removeEmptyPeople();
  });
}
