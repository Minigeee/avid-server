FROM node:17 as builder

# Create app directory
WORKDIR /usr/src/app

# Typescript deps
COPY tsconfig.json ./

# Install app dependencies
COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build


FROM node:slim

ENV NODE_ENV production
ENV PORT 5000
USER node

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

RUN npm ci --production

COPY --from=builder /usr/src/app/credentials ./credentials
COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 5000
CMD [ "node", "dist/src/server.js" ]