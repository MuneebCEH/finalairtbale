/*
  Warnings:

  - You are about to drop the column `created_by_id` on the `records` table. All the data in the column will be lost.
  - You are about to drop the column `updated_by_id` on the `records` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "records" DROP COLUMN "created_by_id",
DROP COLUMN "updated_by_id",
ADD COLUMN     "created_by" CHAR(30),
ADD COLUMN     "updated_by" CHAR(30);
