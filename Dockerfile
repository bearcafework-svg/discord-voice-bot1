FROM node:20-slim
WORKDIR /app
COPY package.json ./
# ใช้ npm install แทน npm ci เพื่อความยืดหยุ่น
RUN npm install
COPY . .
CMD ["node", "index.js"]
