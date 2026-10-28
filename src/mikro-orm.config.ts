import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  metadataProvider: ReflectMetadataProvider,
  clientUrl: process.env.DATABASE_URL,
  entities: [],
  discovery: { warnWhenNoEntities: false }, 
});