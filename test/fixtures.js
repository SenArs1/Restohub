export const ORG = 'org-1';
export const externalMenu = (price = 420) => ({
  id: 'menu-1',
  name: 'Madi Cake',
  itemCategories: [
    {
      id: 'cat-1', name: 'Торты', description: '', headerImageUrl: null,
      items: [
        {
          itemId: 'p-1', sku: '001', name: 'Медовик', description: 'Мёд и сметана',
          allergens: [{ code: 'G', name: 'Глютен' }], tags: [{ id: 't', name: 'Хит' }],
          itemSizes: [
            { sizeName: 'Кусочек', isDefault: true, portionWeightGrams: 150, buttonImageUrl: 'IMG',
              prices: [{ organizationId: ORG, price }], nutritionPerHundredGrams: { energy: 398, proteins: 5, fats: 21, carbs: 46 } },
            { sizeName: 'Целый', portionWeightGrams: 1500, measureUnitType: 'GRAM', prices: [{ organizationId: ORG, price: 3900 }] },
          ],
        },
        { itemId: 'p-2', name: 'Скрытый', isHidden: true, itemSizes: [{ prices: [{ organizationId: ORG, price: 1 }] }] },
        { itemId: 'p-3', name: 'Без цены', itemSizes: [{ prices: [{ organizationId: ORG, price: null }] }] },
      ],
    },
    { id: 'cat-2', name: 'Пустая', items: [] },
  ],
});
