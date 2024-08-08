#!/bin/bash

# Обновление пакетов
sudo apt-get update

# Установка Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Установка Yarn
sudo npm install -g yarn

# Установка Git
sudo apt-get install -y git

# Установка Redis
sudo apt-get install -y redis-server

# Установка Python и pip для Google Cloud Vision
sudo apt-get install -y python3-pip
pip3 install google-cloud-vision

# Установка глобальных npm пакетов
sudo npm install -g ts-node ts-node-dev typescript

# Установка зависимостей проекта
yarn install

# Сборка проекта
yarn build

echo "Установка завершена. Не забудьте проверить настройки файла .env и путь к учетным данным Google Cloud."