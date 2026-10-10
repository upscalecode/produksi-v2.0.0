-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3306
-- Generation Time: Oct 08, 2026 at 08:22 AM
-- Server version: 11.8.9-MariaDB-log
-- PHP Version: 7.2.34

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `u493779344_Produksi`
--

-- --------------------------------------------------------

--
-- Table structure for table `production_master`
--

CREATE TABLE `production_master` (
  `sequence` bigint(20) UNSIGNED NOT NULL,
  `record_id` varchar(191) DEFAULT NULL,
  `category` text DEFAULT NULL,
  `value` text DEFAULT NULL,
  `extra` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '{}'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `production_master`
--

INSERT INTO `production_master` (`sequence`, `record_id`, `category`, `value`, `extra`) VALUES
(1, '069c9fb4bd86249b786c8ac3e437d1d547446c5e58279963486df90eab06c36f', 'produk', 'NINDA LOVEYOU', '[]'),
(2, 'fd9d94a7f80bb84fed4b72118567f7d3041ca5e6851b4244da12f42b4e6bb585', 'botol', 'HERMES CUP GOLD', '[]'),
(3, 'baa3db2de7c12d9bb40c58100314fb38acace1f1fbf25a163cec1a0c459e0396', 'produk', 'NINDA WIT LOVE', '[]'),
(4, '55e478a170739e326c55a280f4ba8805a255ce7572292931db8e52431198150c', 'botol', 'CHANNEL', '[]'),
(5, 'e912035a17f221ba7ddcdcd219d5b0e1bf2866f22978d294cca09c642deb4db0', 'produk', 'JOLIBLISS SCANDALOVE', '[]'),
(6, 'f83117f1d782a76875195edce04a3c3304664cc06062c9c8f66d9f813d119ace', 'botol', 'HERMES', '[]'),
(7, '675233223ce8112c49c1b6e52bd7b620a76f3062e939f49dd6eab8279722e6d3', 'botol', 'JOMALONE', '[]'),
(8, 'e16ce85178e121b3e5156601ec1139271e76c6162e055ba292db9d0cdf2bcb70', 'produk', 'CHARMESKY HONIY', '[]'),
(9, '9bc943cd33ac81fffc1dfe5ecf23881bd18c8a43eb7b9757bea2a5a51ff7a0d0', 'botol', 'PROPLAYER', '[]'),
(10, 'a7ec7b9da5f27c04ff15a9279080075395138d1b46a5184f9bf84907f59d4f9a', 'botol', 'LOLABU', '[]'),
(11, '2a743e5174fb042a0b25fa571ad22a4018ee93c59754ffe8f8f29f2c88590379', 'botol', 'CAREX', '[]'),
(12, '870fa01b7c4b9042ee63cb7d62d364f59fa3c2ca45fd814ad58624970a367523', 'produk', 'VERADA CHITRINE', '[]'),
(13, 'b0ee92c75fd30f51c2c9c847b8623c891fb62a2707d7443eedf6a972b82017ec', 'botol', 'INOCU', '[]'),
(14, '332cb5d097d301c8ea4e1cdc1ea138fdb03930a347c80d02782ddfcfcc6e6d39', 'produk', 'VERADA DIAMOND', '[]'),
(15, 'f9d1c6be0cc246c21f24b5b52a137fac80f523cb00765df48806736678c8a516', 'produk', 'JOLIBLISS BLUEHILL X SCANDALOUSE', '[]'),
(16, '3075c53564e1bafe7efc264ab1b9e0e2c7aabf6d766463b8cfa7afc565cae44c', 'produk', 'JOLIBLISS BACCARAT CANDY', '[]'),
(17, '11b3a2c9cd30607cfa9eadcb655491020dab690372cf808cc814bea40f73297a', 'produk', 'JOLIBLISS SEOUL', '[]'),
(18, '413a141f302e30e77fb3cf59bc202c6ac03c80834c9fb0ecf867b1162dc0e3c2', 'produk', 'JOLIBLISS PARIS', '[]'),
(19, '0602681850b982cbe1383ffd64b1b1018e5d46113ec4bf3345090b85c570f39b', 'produk', 'JOLIBLISS PINK CHIFFON', '[]'),
(20, '23dc50655376cc1e9cff510df06f089761a36a56cfa803dcaa1450aec1b4b9e7', 'produk', 'JOLIBLISS NAGITA', '[]'),
(21, '7deb1ff96a87a3a5cd04a141c07d4597558f9dd793556f3e0673ea9ff72b72bb', 'produk', 'JOLIBLISS OPIUM VANILLA', '[]'),
(22, '0287589f786e1284f320a614d4a134ee25c06fb11bdafeb4f287260bb42a6546', 'produk', 'JOLIBLISS HAPPINESS', '[]'),
(23, 'b72c518afbdaa4f28453652c95b1a28b375e445101499cf8fd6538a3b70c48b8', 'produk', 'JOLIBLISS BRITISH', '[]'),
(24, '307809a9927d1917700267a2156e9044927b9a92d986833072f31f773a380fa9', 'botol', 'JOJO', '[]'),
(25, 'd481d56fe2799752d28538b7e9dcdd6ef54f9913547c16d57b956bf375cf2d24', 'produk', 'Jolibliss Wild Strawberry', '[]'),
(26, 'e328104962d273ef95bfa79b9c53df60c167e59384396e4c5f9cb7bf469e3265', 'produk', 'ABSH DOMINANT', '[]'),
(27, '', 'operator', 'ARIK', '{}');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `production_master`
--
ALTER TABLE `production_master`
  ADD PRIMARY KEY (`sequence`),
  ADD UNIQUE KEY `record_id` (`record_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `production_master`
--
ALTER TABLE `production_master`
  MODIFY `sequence` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=30;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
