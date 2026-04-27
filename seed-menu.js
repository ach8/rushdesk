require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Fetching business...');
  const business = await prisma.business.findFirst({
    orderBy: { createdAt: 'asc' }
  });
  if (!business) {
    console.error('No business found');
    process.exit(1);
  }

  console.log('Wiping old menu items and orders to sync with new IDs...');
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.menuItem.deleteMany();

  const itemsToAdd = [
    { id: 'classic_burger', name: 'Classic Burger', category: 'Plats Principaux', price: 12.00, available: true },
    { id: 'pizza_marg', name: 'Margherita Pizza', category: 'Plats Principaux', price: 14.00, available: true },
    { id: 'fries_crispy', name: 'Crispy Fries', category: 'Accompagnements', price: 4.50, available: true },
    { id: 'salad_caesar', name: 'Caesar Salad', category: 'Accompagnements', price: 8.00, available: true },
    { id: 'coke_regular', name: 'Ice Cold Coke', category: 'Boissons', price: 2.50, available: true }
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
