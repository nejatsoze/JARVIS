-- Kategori adları değişti: "Ulaşım" → "Ulaşım & Konaklama", "Yeme-İçme" → "Yeme & İçme".
UPDATE transactions SET category = 'Ulaşım & Konaklama' WHERE category = 'Ulaşım';
UPDATE transactions SET category = 'Yeme & İçme' WHERE category = 'Yeme-İçme';
UPDATE merchant_categories SET category = 'Ulaşım & Konaklama' WHERE category = 'Ulaşım';
UPDATE merchant_categories SET category = 'Yeme & İçme' WHERE category = 'Yeme-İçme';
