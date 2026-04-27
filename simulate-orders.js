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

  // Setup Menu Items
  const menuData = [
    { name: 'Classic Burger', category: 'Mains', price: 12.00 },
    { name: 'Crispy Fries', category: 'Sides', price: 4.50 },
    { name: 'Ice Cold Coke', category: 'Drinks', price: 2.50 },
    { name: 'Margherita Pizza', category: 'Mains', price: 14.00 },
    { name: 'Caesar Salad', category: 'Sides', price: 8.00 },
  ];

  const items = {};
  for (const item of menuData) {
    let dbItem = await prisma.menuItem.findFirst({
      where: { name: item.name, businessId: business.id }
    });
    if (!dbItem) {
      dbItem = await prisma.menuItem.create({
        data: { ...item, businessId: business.id, available: true }
      });
    }
    items[item.name] = dbItem;
  }

  const now = new Date();
  
  // Define the 10 use cases
  const ordersData = [
    {
      // The specific use case: Same product, different notes
      customerName: 'Kevin (Fries Test)', phone: '0601000011', type: 'TAKEAWAY', source: 'WEB',
      delayMinutes: 0,
      items: [ 
        { item: items['Crispy Fries'], qty: 1, note: 'sans ketchup' },
        { item: items['Crispy Fries'], qty: 1, note: 'avec moutarde' }
      ]
    }
  ];

  const redis = new Redis(process.env.REDIS_URL);

  for (const [index, data] of ordersData.entries()) {
    console.log(`Creating test order ${index + 1}... (${data.customerName})`);
    
    let totalAmount = 0;
    const orderItemsCreate = data.items.map(i => {
      const lineTotal = Number(i.item.price) * i.qty;
      totalAmount += lineTotal;
      return {
        menuItemId: i.item.id,
        quantity: i.qty,
        unitPrice: i.item.price,
        notes: i.note
      };
    });

    const createdAt = new Date(now.getTime() - data.delayMinutes * 60000);

    const order = await prisma.order.create({
      data: {
        businessId: business.id,
        customerName: data.customerName,
        customerPhone: data.phone,
        type: data.type,
        source: data.source,
        status: 'PENDING',
        totalAmount: totalAmount,
        notes: `Simulated order ${index + 1}`,
        paymentStatus: 'NOT_REQUIRED',
        createdAt: createdAt,
        items: {
          create: orderItemsCreate
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

    // Publish to Redis so it appears live
    const event = {
      type: 'order.created',
      businessId: serialized.businessId,
      order: serialized,
    };
    await redis.publish(`rushdesk:orders:${serialized.businessId}`, JSON.stringify(event));
    
    // Pause briefly to simulate live incoming orders
    await new Promise(r => setTimeout(r, 800));
  }

  redis.disconnect();
  console.log('✅ 10 realistic test orders created and broadcasted!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    setTimeout(() => process.exit(0), 1000);
  });
