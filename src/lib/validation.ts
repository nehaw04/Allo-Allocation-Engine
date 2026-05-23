import { z } from 'zod';

export const ReservationSchema = z.object({
  productId: z.string().uuid("Invalid Product ID format"),
  warehouseId: z.string().uuid("Invalid Warehouse ID format"),
  quantity: z.number().int().positive("Quantity must be a positive whole number"),
});