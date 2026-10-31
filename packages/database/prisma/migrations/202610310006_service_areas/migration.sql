CREATE TABLE service_areas (
 id UUID PRIMARY KEY, singleton BOOLEAN NOT NULL DEFAULT true UNIQUE CHECK(singleton),
 warehouse_id UUID NOT NULL UNIQUE REFERENCES warehouses(id) ON DELETE RESTRICT,
 name VARCHAR(100) NOT NULL CHECK(length(trim(name))>0), enabled BOOLEAN NOT NULL DEFAULT false,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE service_buildings (
 id UUID PRIMARY KEY, area_id UUID NOT NULL REFERENCES service_areas(id) ON DELETE RESTRICT,
 name VARCHAR(80) NOT NULL CHECK(length(trim(name))>0),
 name_key VARCHAR(80) NOT NULL CHECK(name_key=lower(name)),
 enabled BOOLEAN NOT NULL DEFAULT false, UNIQUE(area_id,name_key)
);
