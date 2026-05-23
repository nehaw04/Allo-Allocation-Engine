import { prisma } from './db';

export async function releaseExpiredReservations() {
  const now = new Date();

  // Fetch all pending holds that have passed their expiration deadline
  const expiredReservations = await prisma.reservation.findMany({
    where: {
      status: 'PENDING',
      expiresAt: { lt: now }
    }
  });

  if (expiredReservations.length === 0) return;

  // Execute an atomic transaction block to update expired records
  await prisma.$transaction(
    expiredReservations.map((res) =>
      prisma.reservation.update({
        where: { id: res.id },
        data: { status: 'RELEASED' }
      })
    )
  );
}