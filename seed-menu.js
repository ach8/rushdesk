require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Fetching business...');
  const business = await prisma.business.findFirst();
  if (!business) {
    console.error('No business found');
    process.exit(1);
  }

  const itemsToAdd = [
    { name: 'Menu Double Cheese', category: 'Menus', price: 12.50, available: true },
    { name: 'Grande Frites', category: 'Accompagnements', price: 3.50, available: true },
    { name: 'Coca-Cola Zéro', category: 'Boissons', price: 2.50, available: true },
    { name: 'Tiramisu Maison', category: 'Desserts', price: 4.50, available: true }
  ];

  for (const item of itemsToAdd) {
    const existing = await prisma.menuItem.findFirst({
      where: { name: item.name, businessId: business.id }
    });
    if (!existing) {
      await prisma.menuItem.create({
        data: { ...item, businessId: business.id }
      });
      console.log(`Added: ${item.name}`);
    } else {
      console.log(`Already exists: ${item.name}`);
    }
  }

  console.log('\n--- MENU COMPLET POUR ELEVENLABS ---');
  const allItems = await prisma.menuItem.findMany({ where: { businessId: business.id } });
  for (const item of allItems) {
    console.log(`- ${item.name} (ID: ${item.id}) au prix de ${item.price}€`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
