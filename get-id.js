require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.menuItem.findFirst({ where: { name: 'Burger Test' } })
  .then(item => console.log('ITEM_ID:', item.id))
  .catch(console.error)
  .finally(() => prisma.$disconnect());
