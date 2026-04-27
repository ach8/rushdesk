// simulate-orders.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const Redis = require('ioredis');

async function main() {
  console.log('Connecting to database...');
  const business = await prisma.business.findFirst();
  
  if (!business) {
    console.error('No business found. Please create one first.');
    process.exit(1);
  }
  console.log(`Found business: ${business.name}`);

  // Create or find a test menu item
  let burger = await prisma.menuItem.findFirst({
    where: { name: 'Burger Test', businessId: business.id }
  });
  
  if (!burger) {
    console.log('Creating Test Menu Item: Burger Test');
    burger = await prisma.menuItem.create({
      data: {
        businessId: business.id,
        name: 'Burger Test',
        category: 'Test',
        price: 9.99,
        available: true,
      }
    });
  }

  // Generate 3 test orders
  for (let i = 1; i <= 3; i++) {
    console.log(`Creating test order ${i}...`);
    
    // Create the order manually using prisma to bypass any complex logic
    // but mimic the shape of serializeOrder
    const order = await prisma.order.create({
      data: {
        businessId: business.id,
        customerName: `TEST Client ${i}`,
        customerPhone: `060000000${i}`,
        type: 'TAKEAWAY',
        source: 'VOICE',
        status: 'PENDING',
        totalAmount: 9.99 * i,
        notes: `Commande test numéro ${i} (sans oignons)`,
        paymentStatus: 'NOT_REQUIRED',
        items: {
          create: [
            {
              menuItemId: burger.id,
              quantity: i,
              unitPrice: 9.99,
              notes: 'Sans oignons'
            }
          ]
        }
      },
      include: {
        items: {
          include: { menuItem: true }
        }
      }
    });

    // Format for the dashboard
    const serialized = {
      id: order.id,
      businessId: order.businessId,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      type: order.type,
      status: order.status,
      source: order.source,
      totalAmount: Number(order.totalAmount),
      notes: order.notes,
      paymentStatus: order.paymentStatus,
      paymentUrl: order.paymentUrl,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      items: order.items.map(item => ({
        id: item.id,
        menuItemId: item.menuItemId,
        menuItemName: item.menuItem.name,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        notes: item.notes
      }))
    };

    // Publish to Redis so it appears live on Vercel
    const redis = new Redis(process.env.REDIS_URL);
    const event = {
      type: 'order.created',
      businessId: serialized.businessId,
      order: serialized,
    };
    await redis.publish(`rushdesk:orders:${serialized.businessId}`, JSON.stringify(event));
    redis.disconnect();
    
    // Pause briefly between orders
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('✅ 3 test orders created and broadcasted!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Force exit in case Redis connection hangs open
    setTimeout(() => process.exit(0), 1000);
  });
