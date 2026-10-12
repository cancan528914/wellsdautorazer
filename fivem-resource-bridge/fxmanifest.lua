fx_version 'cerulean'
game 'gta5'

name 'javrex-fivem-bridge'
description 'Aktif oyuncu listesini Discord botunun HTTPS API endpointine gonderir (Yontem C).'
author 'Javrex Bot System'
version '1.0.0'

-- YALNIZCA SUNUCU TARAFI. client_script YOKTUR ve EKLENMEMELIDIR.
-- Secret yalnizca sunucu tarafinda okunur; hicbir istemciye gonderilmez.
server_script 'config.lua'
server_script 'server/sv_bridge.lua'