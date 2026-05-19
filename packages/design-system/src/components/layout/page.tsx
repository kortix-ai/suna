import * as React from 'react';
import { cn } from '../../lib/utils';
import { Container, type ContainerProps } from './container';

export interface PageProps extends React.HTMLAttributes<HTMLElement> {
  size?: ContainerProps['size'];
  children: React.ReactNode;
}

export function Page({ size = 'lg', className, children, ...props }: PageProps) {
  return (
    <Container size={size} padded className={cn('py-10 md:py-14', className)} {...props}>
      {children}
    </Container>
  );
}
