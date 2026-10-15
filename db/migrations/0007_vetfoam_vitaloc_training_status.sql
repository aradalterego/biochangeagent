-- Training status for VetFoam and vitaloc, alongside ReGum Vet and MicroFoam. Expand-only.
ALTER TABLE veterinarian_profiles
  ADD COLUMN vetfoam_training_status text NOT NULL DEFAULT 'not_started'
    CHECK (vetfoam_training_status IN ('not_started', 'in_progress', 'completed')),
  ADD COLUMN vitaloc_training_status text NOT NULL DEFAULT 'not_started'
    CHECK (vitaloc_training_status IN ('not_started', 'in_progress', 'completed'));
