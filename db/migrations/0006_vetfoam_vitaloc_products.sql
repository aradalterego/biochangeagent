-- VetFoam and vitaloc join ReGum Vet and MicroFoam as BioChange products. Expand-only.
-- SKUs are placeholders until the approved SKUs and package sizes are entered under Admin → Products.

INSERT INTO products (name, product_family, variant, sku, form, units_per_package, market, description, is_placeholder_sku) VALUES
  ('VetFoam', 'VetFoam', NULL, 'VETFOAM-TBD', 'Injectable gelatin foam (powder syringe + Wings syringe)', 1, 'global',
   'Veterinary product for controlling urethral sphincter mechanism incompetence (USMI) in female dogs, used according to the current approved BioChange IFU.',
   true),
  ('vitaloc', 'vitaloc', NULL, 'VITALOC-TBD', 'Hemostatic powder (500 mg tube)', 1, 'global',
   'Veterinary hemostatic powder for controlling medium-severe bleeding, used according to the current approved BioChange IFU.',
   true)
ON CONFLICT (sku) DO NOTHING;
