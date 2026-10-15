import { afterAll, describe, expect, it } from "vitest";
import { sql, closeDb } from "@/lib/db";
import { getUserProfile, updateUserProfile } from "@/server/domain/profile";
import { recordTrainingActivity } from "@/server/domain/education";
import { actorFor } from "./helpers";

afterAll(() => closeDb());

describe("training status per product", () => {
  it("stores VetFoam and vitaloc training status on the profile", async () => {
    const vet = await actorFor("vet@demo.biochange.test");
    await updateUserProfile(vet, { vetfoamTrainingStatus: "in_progress", vitalocTrainingStatus: "completed" });
    const p = await getUserProfile(vet.userId);
    expect(p.vetfoam_training_status).toBe("in_progress");
    expect(p.vitaloc_training_status).toBe("completed");
  });

  it("marks VetFoam training completed when a VetFoam training course is completed", async () => {
    const vet = await actorFor("clinic-admin@demo.biochange.test");
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO education_resources (title, resource_type, product, level, counts_as_training)
      VALUES ('VetFoam introductory training', 'training_course', 'VetFoam', 'intro', true) RETURNING id`;
    await recordTrainingActivity(vet, r.id, true);
    expect((await getUserProfile(vet.userId)).vetfoam_training_status).toBe("completed");
  });
});
