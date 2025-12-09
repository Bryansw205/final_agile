-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'BILLETERA_DIGITAL';
ALTER TYPE "PaymentMethod" ADD VALUE 'TARJETA_DEBITO';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "installmentId" INTEGER;

-- AlterTable
ALTER TABLE "PaymentSchedule" ADD COLUMN     "isPaid" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Payment_installmentId_idx" ON "Payment"("installmentId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "PaymentSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
