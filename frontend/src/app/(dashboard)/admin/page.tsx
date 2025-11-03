'use client';

import React from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  CreditCard, 
  Bell, 
  Shield,
  Users,
  MessageSquare,
  Settings
} from 'lucide-react';

export default function AdminDashboardPage() {
  const adminSections = [
    {
      title: 'Billing Management',
      description: 'Manage user billing, subscriptions, and account details',
      icon: CreditCard,
      href: '/admin/billing',
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10',
      borderColor: 'border-blue-500/20',
    },
    {
      title: 'Notifications',
      description: 'Send global notifications to users via email and push notifications',
      icon: Bell,
      href: '/admin/notifications',
      color: 'text-purple-500',
      bgColor: 'bg-purple-500/10',
      borderColor: 'border-purple-500/20',
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20">
      <div className="max-w-6xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Shield className="h-8 w-8 text-foreground" />
            <h1 className="text-3xl font-bold tracking-tight">Admin Panel</h1>
          </div>
          <p className="text-muted-foreground">
            Manage users, billing, and system-wide notifications
          </p>
        </div>

        {/* Admin Sections Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {adminSections.map((section) => {
            const Icon = section.icon;
            return (
              <Link key={section.href} href={section.href}>
                <Card className="h-full transition-all hover:shadow-lg hover:scale-[1.02] cursor-pointer border-2 hover:border-primary/50">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className={`p-3 rounded-lg ${section.bgColor} ${section.borderColor} border`}>
                        <Icon className={`h-6 w-6 ${section.color}`} />
                      </div>
                    </div>
                    <CardTitle className="mt-4">{section.title}</CardTitle>
                    <CardDescription>{section.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" className="w-full">
                      Open {section.title.split(' ')[0]}
                      <Icon className="ml-2 h-4 w-4" />
                    </Button>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        {/* Quick Stats */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Quick Access
            </CardTitle>
            <CardDescription>
              Frequently used admin functions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Link href="/admin/billing">
                <Button variant="ghost" className="w-full justify-start gap-2">
                  <Users className="h-4 w-4" />
                  User Management
                </Button>
              </Link>
              <Link href="/admin/notifications">
                <Button variant="ghost" className="w-full justify-start gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Send Notification
                </Button>
              </Link>
              <Link href="/admin/billing">
                <Button variant="ghost" className="w-full justify-start gap-2">
                  <CreditCard className="h-4 w-4" />
                  View Billing
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

