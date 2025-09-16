-- Create database and tables for Smart Home by Nafisa Tabasum

CREATE DATABASE IF NOT EXISTS `dbadminiot_iot` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `dbadminiot_iot`;

-- Users table
CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `email` VARCHAR(190) NULL,
  `role` ENUM('admin','parent','member') NOT NULL DEFAULT 'member',
  `relation` VARCHAR(60) NULL,
  `pin` VARCHAR(16) NULL,
  `preferred_login` ENUM('pin','biometric','face') NOT NULL DEFAULT 'pin',
  `registered_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Face templates (one primary per user; can support multiple versions later)
CREATE TABLE IF NOT EXISTS `face_templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `face_id` VARCHAR(64) NULL,
  `template` LONGTEXT NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_face_id` (`face_id`),
  KEY `idx_user` (`user_id`),
  CONSTRAINT `fk_face_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Door states (optional)
CREATE TABLE IF NOT EXISTS `door_state` (
  `door` VARCHAR(40) NOT NULL,
  `locked` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`door`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Members policies (optional JSON policies per user)
CREATE TABLE IF NOT EXISTS `user_policies` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `policies` LONGTEXT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_policies_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sensor readings captured from hardware devices
CREATE TABLE IF NOT EXISTS `sensor_readings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` VARCHAR(64) NOT NULL,
  `metric` VARCHAR(64) NOT NULL,
  `value` DOUBLE NOT NULL,
  `unit` VARCHAR(24) NULL,
  `metadata` JSON NULL,
  `recorded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_device_metric_time` (`device_id`, `metric`, `recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
