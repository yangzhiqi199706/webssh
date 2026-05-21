import React from "react";
import DashboardCustomizeIcon from '@mui/icons-material/DashboardCustomize';
import Layers from '@mui/icons-material/Layers';
import PhotoIcon from '@mui/icons-material/Photo';
import WallpaperIcon from '@mui/icons-material/Wallpaper';
import UploadFileRoundedIcon from "@mui/icons-material/UploadFileRounded";
import BorderAllIcon from '@mui/icons-material/BorderAll';
import { t } from '../i18n';

export const nav = [
  {
    title: t('itemBox.myPages'),
    icon: <Layers />
  },
  {
    title: t('itemBox.basicComponents'),
    icon: <DashboardCustomizeIcon />
  },
  {
    title: t('itemBox.chartComponents'),
    icon: <DashboardCustomizeIcon />
  },
  {
    title: t('itemBox.templateComponents'),
    icon: <BorderAllIcon />
  },
  {
    title: t('itemBox.pageTemplate'),
    icon: <WallpaperIcon />
  },
  {
    title: t('itemBox.defaultGallery'),
    icon: <PhotoIcon />
  },
  {
    title: t('itemBox.myGallery'),
    icon: <UploadFileRoundedIcon />
  }
];
